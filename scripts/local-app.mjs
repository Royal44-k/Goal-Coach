import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE_VERSION = "24.20.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

function hasLocalPackage(projectRoot, packageName) {
  try {
    const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
    requireFromProject.resolve(`${packageName}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function canBindLoopback(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host: DEFAULT_HOST, port, exclusive: true }, () => {
      probe.close((error) => resolve(error === undefined));
    });
  });
}

export async function runPreflight({
  projectRoot = PROJECT_ROOT,
  port = DEFAULT_PORT,
  nodeVersion = process.versions.node,
} = {}) {
  const root = path.resolve(projectRoot);
  const messages = [];
  let ok = true;

  if (nodeVersion === EXPECTED_NODE_VERSION) {
    messages.push(`[通过] Node.js ${EXPECTED_NODE_VERSION}`);
  } else {
    ok = false;
    messages.push(
      `[失败] 当前 Node.js 为 ${nodeVersion}，必须使用 ${EXPECTED_NODE_VERSION}。请切换到项目固定版本后重试。`,
    );
  }

  if (hasLocalPackage(root, "next")) {
    messages.push("[通过] 已找到本地 Next.js 依赖");
  } else {
    ok = false;
    messages.push("[失败] 缺少本地依赖 Next.js。请按交付说明安装锁文件中的依赖；本命令不会自动安装。");
  }

  if (hasLocalPackage(root, "better-sqlite3")) {
    messages.push("[通过] 已找到本地 SQLite 依赖");
  } else {
    ok = false;
    messages.push(
      "[失败] 缺少本地 SQLite 依赖 better-sqlite3。请按交付说明安装锁文件中的依赖；本命令不会自动安装。",
    );
  }

  if (existsSync(path.join(root, ".next", "BUILD_ID"))) {
    messages.push("[通过] 已找到 Next.js 生产构建");
  } else {
    ok = false;
    messages.push("[失败] 未找到 Next.js 生产构建（.next/BUILD_ID）。请先显式运行 pnpm build。");
  }

  if (await canBindLoopback(port)) {
    messages.push(`[通过] 回环地址 ${DEFAULT_HOST}:${port} 可用`);
  } else {
    ok = false;
    messages.push(
      `[失败] 端口 ${DEFAULT_HOST}:${port} 已被占用或无法独占绑定。请保留现有监听器并选择停止正确的本项目进程；本命令不会结束任何进程。`,
    );
  }

  return { ok, messages };
}

function resolveNextCli(projectRoot) {
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
  return requireFromProject.resolve("next/dist/bin/next");
}

function runNextChild({ projectRoot, port }) {
  const nextCli = resolveNextCli(projectRoot);
  const child = spawn(
    process.execPath,
    [nextCli, "start", "--hostname", DEFAULT_HOST, "--port", String(port)],
    {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
    },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== null) {
        resolve(code);
      } else {
        resolve(signal === "SIGINT" ? 130 : 1);
      }
    });
  });
}

export async function startLocalApp({ projectRoot = PROJECT_ROOT, port = DEFAULT_PORT } = {}) {
  const root = path.resolve(projectRoot);
  const result = await runPreflight({ projectRoot: root, port });
  if (!result.ok) {
    throw new Error(`本机启动预检未通过：\n${result.messages.join("\n")}`);
  }
  return runNextChild({ projectRoot: root, port });
}

async function main() {
  const command = process.argv[2];
  if (command === "check") {
    const result = await runPreflight();
    for (const message of result.messages) console.log(message);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "start") {
    process.exitCode = await startLocalApp();
    return;
  }
  console.error("用法：node scripts/local-app.mjs <check|start>");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
