import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDatabase } from "../src/server/db/client";
import { AuthService } from "../src/server/auth/auth-service";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "auth-cli-")); dirs.push(dir); return join(dir, "cli.db"); }
function cli(path: string, args: string[], input = ""): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/auth-admin.ts", ...args], {
      env: { ...process.env, DATABASE_PATH: path, APP_MODE: "invite", APP_ORIGIN: "http://127.0.0.1:3000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

test("CLI bootstrap is guarded and reset accepts only stdin and revokes sessions", async () => {
  const path = fixture();
  const boot = await cli(path, ["bootstrap"]);
  expect(boot.code, boot.output).toBe(0);
  const token = boot.output.match(/[A-Za-z0-9_-]{43}/)?.[0];
  expect(token).toBeTruthy();
  expect((await cli(path, ["bootstrap"])).code).toBe(1);
  const db = createDatabase(path);
  try {
    const service = new AuthService({ database: db });
    const session = await service.register({ inviteToken: token!, username: "cliuser", password: "initial synthetic password" });
    const reset = await cli(path, ["reset-password", "cliuser"], "replacement synthetic password\n");
    expect(reset.code).toBe(0);
    expect(reset.output).not.toContain("replacement synthetic password");
    expect(service.authenticate(session.token)).toBeNull();
    expect((await service.login({ username: "cliuser", password: "replacement synthetic password" })).actor.username).toBe("cliuser");
    const forbidden = await cli(path, ["reset-password", "cliuser", "argument synthetic password"]);
    expect(forbidden.code).toBe(1);
    expect(forbidden.output).not.toContain("argument synthetic password");
    expect((await cli(path, ["reset-password", "cliuser"], "x".repeat(1024))).code).toBe(1);
  } finally { db.$client.close(); }
}, 15_000);
