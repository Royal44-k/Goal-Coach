import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdir, rm, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createDatabase, type AppDatabase } from "../src/server/db/client";
import { migrateDatabase } from "../src/server/db/migrate";

const host = "127.0.0.1";
const port = Number(process.env.E2E_PORT ?? "3000");
const origin = process.env.APP_ORIGIN ?? `http://${host}:${port}`;
const runPrefix = "goal-coach-e2e-";
const require = createRequire(import.meta.url);
type TerminationDiagnostics = {
  branch: "not_started" | "already_closed" | "spawn_failed" | "missing_pid" | "pid_absent" | "taskkill_failed" | "waited_for_close" | "pid_absent_after_taskkill";
  startedAt: number;
  taskkillError: string | null;
  taskkillExitCode: number | null;
  taskkillSignal: NodeJS.Signals | null;
  taskkillTimedOut: boolean;
  taskkillDurationMs: number | null;
  taskkillStderr: string;
  closeWaitTimedOut: boolean;
  pidProbeError: string | null;
  usedServerPidFallback: boolean;
};
type OwnedProcess = {
  child: ChildProcess;
  spawnedAt: number;
  exited: boolean;
  exitedAt: number | null;
  closed: boolean;
  closedAt: number | null;
  spawnError: Error | null;
  termination: TerminationDiagnostics | null;
};

function assertOwnedRunDirectory(path: string): void {
  const resolved = resolve(path);
  const expectedParent = resolve(tmpdir());
  const name = basename(resolved);
  if (dirname(resolved) !== expectedParent || !new RegExp(`^${runPrefix}[0-9a-f-]{36}$`, "i").test(name)) {
    throw new Error(`Refusing unsafe e2e path: ${resolved}`);
  }
}

async function assertBindAvailable(address: string): Promise<void> {
  await new Promise<void>((resolveBind, rejectBind) => {
    const server = createServer();
    server.unref();
    server.once("error", error => rejectBind(new Error(`Port ${port} is unavailable on ${address}: ${error.message}`)));
    server.listen({ host: address, port, exclusive: true }, () => {
      server.close(error => error ? rejectBind(error) : resolveBind());
    });
  });
}

async function refuseExistingListeners(): Promise<void> {
  for (const address of ["0.0.0.0", "::", "127.0.0.1", "::1"]) {
    await assertBindAvailable(address);
  }
}

function trackOwnedProcess(child: ChildProcess): OwnedProcess {
  const owned: OwnedProcess = {
    child,
    spawnedAt: Date.now(),
    exited: false,
    exitedAt: null,
    closed: false,
    closedAt: null,
    spawnError: null,
    termination: null,
  };
  child.once("error", error => { owned.spawnError = error; });
  child.once("exit", () => { owned.exited = true; owned.exitedAt = Date.now(); });
  child.once("close", () => { owned.closed = true; owned.closedAt = Date.now(); });
  return owned;
}

function waitForClose(owned: OwnedProcess, timeoutMs = 15_000): Promise<boolean> {
  if (owned.closed) return Promise.resolve(true);
  return new Promise(resolveClose => {
    const timer = setTimeout(() => resolveClose(false), timeoutMs);
    owned.child.once("close", () => { clearTimeout(timer); resolveClose(true); });
    if (owned.closed) { clearTimeout(timer); resolveClose(true); }
  });
}

function isExactPidAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}

async function terminateOwnedProcess(owned: OwnedProcess | null, allowServerPidFallback = false): Promise<boolean> {
  if (!owned) return true;
  const termination: TerminationDiagnostics = {
    branch: "not_started",
    startedAt: Date.now(),
    taskkillError: null,
    taskkillExitCode: null,
    taskkillSignal: null,
    taskkillTimedOut: false,
    taskkillDurationMs: null,
    taskkillStderr: "",
    closeWaitTimedOut: false,
    pidProbeError: null,
    usedServerPidFallback: false,
  };
  owned.termination = termination;
  if (owned.closed) { termination.branch = "already_closed"; return true; }
  const child = owned.child;
  if (owned.spawnError && !child.pid) { termination.branch = "spawn_failed"; return true; }
  if (!child.pid) { termination.branch = "missing_pid"; return false; }
  if (allowServerPidFallback) {
    try {
      if (isExactPidAbsent(child.pid)) {
        termination.branch = "pid_absent";
        termination.usedServerPidFallback = true;
        return true;
      }
    } catch (error) {
      termination.pidProbeError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
  if (process.platform === "win32") {
    const killerStartedAt = Date.now();
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    killer.stderr?.on("data", chunk => { termination.taskkillStderr = `${termination.taskkillStderr}${String(chunk)}`.slice(-2000); });
    const killerCompleted = await new Promise<boolean>(resolveKiller => {
      const timer = setTimeout(() => {
        termination.taskkillTimedOut = true;
        termination.taskkillDurationMs = Date.now() - killerStartedAt;
        resolveKiller(false);
      }, 5_000);
      killer.once("error", error => {
        clearTimeout(timer);
        termination.taskkillError = error.message;
        termination.taskkillDurationMs = Date.now() - killerStartedAt;
        resolveKiller(false);
      });
      killer.once("close", (code, signal) => {
        clearTimeout(timer);
        termination.taskkillExitCode = code;
        termination.taskkillSignal = signal;
        termination.taskkillDurationMs = Date.now() - killerStartedAt;
        resolveKiller(true);
      });
    });
    if (!killerCompleted) { termination.branch = "taskkill_failed"; return false; }
  } else {
    try { child.kill("SIGTERM"); } catch { return false; }
  }
  termination.branch = "waited_for_close";
  const closed = await waitForClose(owned);
  termination.closeWaitTimedOut = !closed;
  if (closed || !allowServerPidFallback) return closed;
  try {
    if (isExactPidAbsent(child.pid)) {
      termination.branch = "pid_absent_after_taskkill";
      termination.usedServerPidFallback = true;
      return true;
    }
  } catch (error) {
    termination.pidProbeError = error instanceof Error ? error.message : String(error);
  }
  return false;
}

function diagnosticsFor(owned: OwnedProcess | null) {
  if (!owned) return null;
  return {
    pid: owned.child.pid ?? null,
    spawnedAt: owned.spawnedAt,
    spawnError: owned.spawnError?.message ?? null,
    exited: owned.exited,
    exitedAt: owned.exitedAt,
    closed: owned.closed,
    closedAt: owned.closedAt,
    exitCode: owned.child.exitCode,
    signalCode: owned.child.signalCode,
    termination: owned.termination,
  };
}

async function waitForBuild(owned: OwnedProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (owned.spawnError) throw new Error(`Owned e2e build failed to spawn: ${owned.spawnError.message}`);
    if (owned.closed) {
      if (owned.child.exitCode !== 0) throw new Error(`Owned e2e production build failed (${owned.child.exitCode}).\n${output().slice(-6000)}`);
      return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const closed = await terminateOwnedProcess(owned);
  if (!closed) throw new Error("Owned e2e build timed out and shutdown could not be proven");
  throw new Error(`Owned e2e production build exceeded 120 seconds.\n${output().slice(-6000)}`);
}

async function waitForOwnedServer(owned: OwnedProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (owned.spawnError) throw new Error(`Owned e2e server failed to spawn: ${owned.spawnError.message}`);
    if (owned.closed) {
      throw new Error(`Owned e2e server exited before readiness.\n${output().slice(-6000)}`);
    }
    if (/Ready in|started server/i.test(output())) {
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
        const body = await response.json();
        if (response.ok && body.ok === true && !owned.closed && !owned.spawnError) return;
      } catch {
        // The owned process has not completed its listen/serve transition yet.
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
  }
  throw new Error(`Owned e2e server did not become ready.\n${output().slice(-6000)}`);
}

export async function setupIsolatedApp(options: {
  mode: "local" | "invite";
  initialize?: (database: AppDatabase) => void;
}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || origin !== `http://${host}:${port}`) {
    throw new Error("Local E2E requires E2E_PORT 1024–65535 and its exact 127.0.0.1 APP_ORIGIN");
  }
  const projectRoot = resolve(process.cwd());
  if ((await readdir(projectRoot)).some(name => name.startsWith(".env") && name !== ".env.example")) {
    throw new Error("E2E requires a private-env-free source copy; do not move or remove private configuration");
  }
  const runDirectory = join(resolve(tmpdir()), `${runPrefix}${randomUUID()}`);
  assertOwnedRunDirectory(runDirectory);
  await refuseExistingListeners();
  await mkdir(runDirectory, { recursive: false });
  const databasePath = join(runDirectory, "goal-coach.db");
  process.env.GOAL_COACH_E2E_DATABASE_PATH = databasePath;
  const environment = {
    ...process.env,
    DATABASE_PATH: databasePath,
    APP_MODE: options.mode,
    APP_ORIGIN: origin,
    MODEL_PROVIDER: "mock",
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_BASE_URL: "",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "deepseek-flash",
    DEEPSEEK_MAX_OUTPUT_TOKENS: "2048",
    QWEN_MODEL: "qwen3.7-flash-2026-07-15",
    QWEN_FALLBACK_MODEL: "qwen3.7-plus-2026-05-26",
    ENABLE_QWEN_FALLBACK: "false",
    DAILY_INPUT_TOKEN_LIMIT: "100000",
    DAILY_OUTPUT_TOKEN_LIMIT: "30000",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--require="${join(projectRoot, "e2e", "block-external-network.cjs").replaceAll("\\", "/")}"`,
  };
  let build: OwnedProcess | null = null;
  let server: OwnedProcess | null = null;
  let buildOutput = "";
  let serverOutput = "";

  const cleanup = async () => {
    const serverClosed = await terminateOwnedProcess(server, true);
    const buildClosed = await terminateOwnedProcess(build);
    if (!serverClosed || !buildClosed) {
      throw new Error(`Owned e2e process shutdown could not be proven; retained isolated data at ${runDirectory}. Diagnostics: ${JSON.stringify({ serverClosed, buildClosed, server: diagnosticsFor(server), build: diagnosticsFor(build) })}`);
    }
    try {
      await refuseExistingListeners();
    } catch (error) {
      throw new Error(`Owned e2e server-stop bind proof failed; retained isolated data at ${runDirectory}. ${error instanceof Error ? error.message : String(error)}`);
    }
    assertOwnedRunDirectory(runDirectory);
    await rm(runDirectory, { recursive: true, force: true });
    if (`${buildOutput}${serverOutput}`.includes("E2E_EXTERNAL_NETWORK_BLOCKED")) {
      throw new Error("Application attempted external network access during offline acceptance");
    }
  };

  try {
    // Readiness is read-only: prepare only this guarded, synthetic database first.
    const database = createDatabase(databasePath);
    try { migrateDatabase(database); options.initialize?.(database); } finally { database.$client.close(); }
    const nextCli = require.resolve("next/dist/bin/next");
    build = trackOwnedProcess(spawn(process.execPath, [nextCli, "build"], {
      cwd: projectRoot,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    build.child.stdout?.on("data", chunk => { buildOutput += String(chunk); });
    build.child.stderr?.on("data", chunk => { buildOutput += String(chunk); });
    await waitForBuild(build, () => buildOutput);
    await refuseExistingListeners();
    server = trackOwnedProcess(spawn(process.execPath, [nextCli, "start", "--hostname", host, "--port", String(port)], {
      cwd: projectRoot,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    server.child.stdout?.on("data", chunk => { serverOutput += String(chunk); });
    server.child.stderr?.on("data", chunk => { serverOutput += String(chunk); });
    await waitForOwnedServer(server, () => serverOutput);
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `E2E setup and safe cleanup both failed: ${String(error)}; ${String(cleanupError)}`);
    }
    throw error;
  }

  return cleanup;
}

export default async function globalSetup() {
  return setupIsolatedApp({ mode: "local" });
}
