import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";

import { runPreflight, startLocalApp } from "./local-app.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./local-app.mjs", import.meta.url));

async function makeFixture({ complete = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "goal-coach-local-app-test-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","private":true}\n');
  await writeFile(path.join(root, ".env.local"), "PRIVATE_TOKEN=synthetic-private-sentinel\n");
  await cp(SCRIPT_PATH, path.join(root, "scripts", "local-app.mjs"));
  if (complete) {
    await mkdir(path.join(root, ".next"), { recursive: true });
    await writeFile(path.join(root, ".next", "BUILD_ID"), "fixture-build\n");
    await createDependency(root, "better-sqlite3");
    await createDependency(root, "next");
  }
  return root;
}

async function createDependency(root, name) {
  const packageRoot = path.join(root, "node_modules", name);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", main: "index.js" })}\n`,
  );
  await writeFile(path.join(packageRoot, "index.js"), "module.exports = {};\n");
}

async function listen(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return server;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function snapshotTree(root, current = root) {
  const snapshot = [];
  for (const name of (await readdir(current)).sort()) {
    const absolute = path.join(current, name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      snapshot.push(`${relative}/`);
      snapshot.push(...(await snapshotTree(root, absolute)));
    } else {
      const bytes = await readFile(absolute);
      snapshot.push(`${relative}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
  return snapshot;
}

function spawnAndCollect(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("CLI check reports missing local requirements without reading env contents or changing files", async ({ onTestFinished }) => {
  const root = await makeFixture({ complete: false });
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const before = await snapshotTree(root);

  const result = await spawnAndCollect(process.execPath, [path.join(root, "scripts", "local-app.mjs"), "check"], {
    cwd: root,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /缺少.*Next|Next.*缺少/);
  assert.match(result.stdout + result.stderr, /生产构建/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-sentinel/);
  assert.deepEqual(await snapshotTree(root), before);
});

test("preflight refuses an occupied port and leaves the unrelated listener alive", async ({ onTestFinished }) => {
  const root = await makeFixture();
  const server = await listen();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  onTestFinished(() => close(server));
  const address = server.address();
  assert.equal(typeof address, "object");
  const before = await snapshotTree(root);

  const result = await runPreflight({ projectRoot: root, port: address.port });

  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /端口.*占用/);
  assert.equal(server.listening, true);
  assert.deepEqual(await snapshotTree(root), before);
});

test("preflight rejects a Node version other than the exact pinned version", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const result = await runPreflight({ projectRoot: root, port: 0, nodeVersion: "24.20.1" });

  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /24\.20\.0/);
  assert.match(result.messages.join("\n"), /24\.20\.1/);
});

test("start runs the installed Next CLI in the foreground with loopback args and inherited database path", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  await mkdir(path.dirname(nextBin), { recursive: true });
  await writeFile(
    nextBin,
    [
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.INVOCATION_PATH, JSON.stringify({ args: process.argv.slice(2), databasePath: process.env.DATABASE_PATH }));',
    ].join("\n"),
  );
  const probe = await listen();
  const address = probe.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await close(probe);
  const invocationPath = path.join(root, "invocation.json");
  const driverPath = path.join(root, "start-driver.mjs");
  await writeFile(
    driverPath,
    `import { startLocalApp } from ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)};\n` +
      `process.exitCode = await startLocalApp({ projectRoot: ${JSON.stringify(root)}, port: ${port} });\n`,
  );

  const result = await spawnAndCollect(process.execPath, [driverPath], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_PATH: path.join(root, "explicit.db"),
      INVOCATION_PATH: invocationPath,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(invocationPath, "utf8")), {
    args: ["start", "--hostname", "127.0.0.1", "--port", String(port)],
    databasePath: path.join(root, "explicit.db"),
  });
});

test("start refuses an occupied port without launching Next or stopping the listener", async ({ onTestFinished }) => {
  const root = await makeFixture();
  const server = await listen();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  onTestFinished(() => close(server));
  const address = server.address();
  assert.equal(typeof address, "object");
  const marker = path.join(root, "launched.txt");
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  await mkdir(path.dirname(nextBin), { recursive: true });
  await writeFile(nextBin, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "launched");\n`);

  await assert.rejects(startLocalApp({ projectRoot: root, port: address.port }), /预检未通过/);

  assert.equal(server.listening, true);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});
