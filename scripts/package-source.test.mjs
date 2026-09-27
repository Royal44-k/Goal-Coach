import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { packageSource } from "./package-source.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./package-source.mjs", import.meta.url));

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "goal-coach-package-test-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "drizzle"), { recursive: true });
  await mkdir(path.join(root, "docs", "delivery"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "public", "icons"), { recursive: true });
  await mkdir(path.join(root, "src", "app"), { recursive: true });
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "private-package"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"goal-coach-agent","version":"1.2.3","private":true}\n',
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(root, ".env.example"), "DATABASE_PATH=./data/goal-coach.db\n");
  await writeFile(path.join(root, ".env.local"), "SECRET=synthetic-private-sentinel\n");
  await writeFile(path.join(root, "src", "app.ts"), "export const answer = 42;\n");
  for (const file of ["sw.js", "offline.html", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon-180.png"]) {
    await writeFile(path.join(root, "public", file), `safe fixture ${file}`);
  }
  await writeFile(path.join(root, "src", "app", "manifest.ts"), "export default function manifest() { return {}; }\n");
  await writeFile(path.join(root, "drizzle", "0001.sql"), "CREATE TABLE sample(id TEXT);\n");
  await writeFile(path.join(root, "docs", "delivery", "README.md"), "# Delivery\n");
  await writeFile(path.join(root, "data", "secret.db"), "private database bytes");
  await writeFile(path.join(root, "debug.log"), "private log bytes");
  await writeFile(path.join(root, "node_modules", "private-package", "index.js"), "secret");
  await cp(SCRIPT_PATH, path.join(root, "scripts", "package-source.mjs"));
  return root;
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("CLI copies allowlisted source bytes with independent SHA-256 hashes and excludes private data", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [path.join(root, "scripts", "package-source.mjs")], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = path.join(root, "dist", "goal-coach-agent-source-v1.2.3");
  assert.deepEqual((await readdir(output)).sort(), [
    ".env.example",
    "docs",
    "drizzle",
    "manifest.json",
    "package.json",
    "pnpm-lock.yaml",
    "public",
    "scripts",
    "src",
  ]);
  assert.equal(await readFile(path.join(output, "src", "app.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(await exists(path.join(output, ".env.local")), false);
  assert.equal(await exists(path.join(output, "data")), false);
  assert.equal(await exists(path.join(output, "node_modules")), false);
  assert.equal(await exists(path.join(output, "debug.log")), false);

  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.algorithm, "sha256");
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    [
      ".env.example",
      "docs/delivery/README.md",
      "drizzle/0001.sql",
      "package.json",
      "pnpm-lock.yaml",
      "public/icons/apple-touch-icon-180.png",
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/offline.html",
      "public/sw.js",
      "scripts/package-source.mjs",
      "src/app.ts",
      "src/app/manifest.ts",
    ],
  );
  assert.equal(
    manifest.files.find((entry) => entry.path === "src/app.ts")?.sha256,
    createHash("sha256").update("export const answer = 42;\n").digest("hex"),
  );
});

test("refuses a package missing an install or offline asset before creating a destination", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await rm(path.join(root, "public", "sw.js"));
  await assert.rejects(packageSource(root), /PWA/u);
  assert.equal(await exists(path.join(root, "dist")), false);
});

test("keeps the nested data clear API source while excluding top-level data and database files anywhere", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "app", "api", "data", "clear"), { recursive: true });
  await writeFile(
    path.join(root, "src", "app", "api", "data", "clear", "route.ts"),
    "export const runtime = 'nodejs';\n",
  );
  await writeFile(path.join(root, "src", "nested-secret.sqlite"), "private nested database bytes");

  const { outputDirectory, manifest } = await packageSource(root);

  assert.equal(
    await readFile(path.join(outputDirectory, "src", "app", "api", "data", "clear", "route.ts"), "utf8"),
    "export const runtime = 'nodejs';\n",
  );
  assert.equal(await exists(path.join(outputDirectory, "data")), false);
  assert.equal(await exists(path.join(outputDirectory, "src", "nested-secret.sqlite")), false);
  assert.equal(
    manifest.files.some((entry) => entry.path === "src/app/api/data/clear/route.ts"),
    true,
  );
  assert.equal(manifest.files.some((entry) => entry.path.endsWith("nested-secret.sqlite")), false);
});

test("delivery includes deployment artifacts and only the exact deployment environment example", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "deploy", "nested"), { recursive: true });
  await mkdir(path.join(root, "e2e-invite"));
  for (const file of ["Dockerfile", ".dockerignore", "compose.yaml", "deploy/Caddyfile", "deploy/.env.example", "playwright.invite.config.ts", "e2e-invite/acceptance.spec.ts"]) {
    await writeFile(path.join(root, file), `safe fixture ${file}`);
  }
  for (const file of ["deploy/.env", "deploy/.env.local", "deploy/nested/.env.example", "deploy/nested/secrets.db-wal", "deploy/private.log"]) {
    await writeFile(path.join(root, file), "synthetic-private-sentinel");
  }
  const { outputDirectory, manifest } = await packageSource(root);
  const listing = (await readdir(outputDirectory, { recursive: true })).map(file => file.replaceAll("\\", "/"));
  for (const file of ["Dockerfile", ".dockerignore", "compose.yaml", "deploy/Caddyfile", "deploy/.env.example", "playwright.invite.config.ts", "e2e-invite/acceptance.spec.ts"]) {
    assert.ok(listing.includes(file), file);
    assert.equal(await readFile(path.join(outputDirectory, file), "utf8"), `safe fixture ${file}`);
  }
  for (const entry of manifest.files) {
    assert.equal((await readFile(path.join(outputDirectory, entry.path), "utf8")).includes("synthetic-private-sentinel"), false);
  }
  assert.equal(listing.some(file => file.includes(".env") && ![".env.example", "deploy/.env.example"].includes(file)), false);
});

test("a symlink in an allowlisted tree is rejected before any destination is created", async ({ onTestFinished }) => {
  const root = await makeFixture();
  const outside = await mkdtemp(path.join(tmpdir(), "goal-coach-package-outside-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "escape");
  await symlink(outside, path.join(root, "src", "escape"), "junction");

  await assert.rejects(packageSource(root), /符号链接/);
  assert.equal(await exists(path.join(root, "dist")), false);
});

test("environment example exception requires the exact case-sensitive deployment path", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "deploy"));
  await writeFile(path.join(root, "deploy", ".ENV.EXAMPLE"), "synthetic-private-sentinel");
  const { outputDirectory, manifest } = await packageSource(root);
  assert.equal(manifest.files.some(file => file.path.startsWith("deploy/")), false);
  assert.equal(await exists(path.join(outputDirectory, "deploy", ".ENV.EXAMPLE")), false);
});

test("excludes named environment files while retaining only the two exact examples", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "deploy"));
  await writeFile(path.join(root, "deploy", ".env.example"), "safe deployment example\n");
  const privateFiles = ["deploy/prod.env", "deploy/prod.env.local", "src/secrets.env", "src/secrets.env.production"];
  for (const relative of privateFiles) await writeFile(path.join(root, relative), "synthetic-private-sentinel");

  const { outputDirectory, manifest } = await packageSource(root);

  assert.equal(manifest.files.some(entry => entry.path === ".env.example"), true);
  assert.equal(manifest.files.some(entry => entry.path === "deploy/.env.example"), true);
  for (const relative of privateFiles) {
    assert.equal(manifest.files.some(entry => entry.path === relative), false, relative);
    assert.equal(await exists(path.join(outputDirectory, relative)), false, relative);
  }
});

test("excludes db3 and sqlite3 snapshots and sidecars from allowlisted source directories", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const privateFiles = ["src/old.db3", "src/old.db3-wal", "src/old.db3-shm", "src/old.db3-journal",
    "scripts/old.sqlite3", "scripts/old.sqlite3-wal", "scripts/old.sqlite3-shm", "scripts/old.sqlite3-journal"];
  for (const relative of privateFiles) await writeFile(path.join(root, relative), "synthetic-private-sentinel");

  const { outputDirectory, manifest } = await packageSource(root);

  for (const relative of privateFiles) {
    assert.equal(manifest.files.some(entry => entry.path === relative), false, relative);
    assert.equal(await exists(path.join(outputDirectory, relative)), false, relative);
  }
});

test("concurrent same-version packaging grants one writer ownership and preserves its artifact", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const results = await Promise.allSettled([packageSource(root), packageSource(root)]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /已存在/);
  const outputDirectory = fulfilled[0].value.outputDirectory;
  assert.equal(await readFile(path.join(outputDirectory, "src", "app.ts"), "utf8"), "export const answer = 42;\n");
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.files.some((entry) => entry.path === "src/app.ts"), true);
});

test("an existing versioned output is refused without changing its contents", async ({ onTestFinished }) => {
  const root = await makeFixture();
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "dist", "goal-coach-agent-source-v1.2.3");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "keep.txt"), "do not replace\n");

  await assert.rejects(packageSource(root), /已存在/);

  assert.deepEqual(await readdir(output), ["keep.txt"]);
  assert.equal(await readFile(path.join(output, "keep.txt"), "utf8"), "do not replace\n");
});
