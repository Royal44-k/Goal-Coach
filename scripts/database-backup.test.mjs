import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { test } from "vitest";

const backupScript = fileURLToPath(new URL("./database-backup.mjs", import.meta.url));
const restoreScript = fileURLToPath(new URL("./database-restore.mjs", import.meta.url));
function run(script, args, source) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, DATABASE_PATH: source ?? "" }, encoding: "utf8", timeout: 15_000,
  });
}
async function fixture(onTestFinished) {
  const root = await mkdtemp(path.join(tmpdir(), "goal-coach-maintenance-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.db");
  const db = new Database(source);
  onTestFinished(() => { if (db.open) db.close(); });
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id)); INSERT INTO parents VALUES(7); INSERT INTO children VALUES(1,7)");
  return { root, source, db };
}
function assertSnapshot(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(db.prepare("SELECT * FROM children").all(), [{ id: 1, parent_id: 7 }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally { db.close(); }
}

test("backup snapshots committed WAL rows while writer stays open; restore reopens with valid rows and constraints", async ({ onTestFinished }) => {
  const { root, source, db } = await fixture(onTestFinished);
  assert.ok((await readFile(`${source}-wal`)).length > 0);
  const backup = path.join(root, "backup.db");
  const result = run(backupScript, ["--", backup], source);
  assert.equal(result.status, 0, result.stderr);
  assertSnapshot(backup);
  db.exec("INSERT INTO parents VALUES(8)");
  const restored = path.join(root, "restored.db");
  const restore = run(restoreScript, ["--", backup, restored]);
  assert.equal(restore.status, 0, restore.stderr);
  assertSnapshot(restored);
  const restoredDb = new Database(restored);
  assert.deepEqual(restoredDb.prepare("SELECT * FROM parents").all(), [{ id: 7 }]);
  restoredDb.close();
});

test("WAL backup and restore produce self-contained rollback-journal files without changing the live source", async ({ onTestFinished }) => {
  const { root, source, db } = await fixture(onTestFinished);
  const beforeMain = await readFile(source);
  const beforeWal = await readFile(`${source}-wal`);
  const backup = path.join(root, "standalone-backup.db");
  const restored = path.join(root, "standalone-restored.db");
  assert.equal(run(backupScript, [backup], source).status, 0);
  assert.equal(run(restoreScript, [backup, restored]).status, 0);
  for (const file of [backup, restored]) {
    // SQLite header read/write versions 1/1 mean rollback journal, not WAL (2/2).
    assert.deepEqual([...(await readFile(file)).subarray(18, 20)], [1, 1]);
    const check = new Database(file, { readonly: true, fileMustExist: true });
    try {
      assert.equal(check.pragma("journal_mode", { simple: true }), "delete");
      assert.deepEqual(await readdir(root).then(names => names.filter(name => name.startsWith(`${path.basename(file)}-`))), []);
    } finally { check.close(); }
    assertSnapshot(file);
  }
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.deepEqual(await readFile(source), beforeMain);
  assert.deepEqual(await readFile(`${source}-wal`), beforeWal);
  db.exec("INSERT INTO parents VALUES(8)");
  assert.equal(db.prepare("SELECT count(*) AS count FROM parents").get().count, 2);
});

test.skipIf(process.platform !== "win32")("restore CLI reads a Windows ACL-protected input with proven file and directory write denial", async ({ onTestFinished }) => {
  const { root, source } = await fixture(onTestFinished);
  const inputDirectory = path.join(root, "readonly-input");
  await mkdir(inputDirectory);
  const backup = path.join(inputDirectory, "snapshot.db");
  assert.equal(run(backupScript, [backup], source).status, 0);
  const bytes = await readFile(backup);
  const changed = [];
  const acl = (target, ...args) => spawnSync("icacls.exe", [target, ...args], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  try {
    // WD/AD deny writing/appending this file and creating files/subdirectories.
    // Exact fixture paths only; preserve all preexisting inherited permissions.
    for (const target of [backup, inputDirectory]) {
      const result = acl(target, "/deny", "*S-1-1-0:(WD,AD)");
      assert.equal(result.status, 0, result.stderr);
      changed.push(target);
    }
    await assert.rejects(writeFile(path.join(inputDirectory, "denial-probe"), "must fail", { flag: "wx" }), error => ["EACCES", "EPERM"].includes(error.code));
    await assert.rejects(writeFile(backup, "must fail"), error => ["EACCES", "EPERM"].includes(error.code));
    const restored = path.join(root, "restored-from-readonly.db");
    const result = run(restoreScript, ["--", backup, restored]);
    assert.equal(result.status, 0, result.stderr);
    assertSnapshot(restored);
    assert.deepEqual(await readdir(inputDirectory), ["snapshot.db"]);
    assert.deepEqual(await readFile(backup), bytes);
  } finally {
    // Restore only our explicit deny ACEs, before normal owned-fixture cleanup.
    for (const target of changed.reverse()) {
      const result = acl(target, "/remove:d", "*S-1-1-0");
      assert.equal(result.status, 0, `Unable to restore fixture ACL: ${result.stderr}`);
    }
  }
});

for (const action of ["backup", "restore"]) {
  test(`${action} refuses an existing destination and source aliases without changing any bytes`, async ({ onTestFinished }) => {
    const { root, source } = await fixture(onTestFinished);
    const dest = path.join(root, "existing.db");
    const bytes = Buffer.from("must remain byte-identical");
    await writeFile(dest, bytes);
    const script = action === "backup" ? backupScript : restoreScript;
    const invoke = target => run(script, action === "backup" ? [target] : [source, target], source);
    assert.notEqual(invoke(dest).status, 0);
    assert.deepEqual(await readFile(dest), bytes);
    const original = await readFile(source);
    assert.notEqual(invoke(source).status, 0);
    assert.deepEqual(await readFile(source), original);
    const alias = path.join(root, "alias.db");
    await link(source, alias);
    assert.notEqual(invoke(alias).status, 0);
    assert.deepEqual(await readFile(alias), original);
  });

  for (const bad of ["missing", "corrupt", "empty", "foreign-key"]) {
    test(`${action} rejects ${bad} source without publishing output`, async ({ onTestFinished }) => {
      const { root, source, db } = await fixture(onTestFinished);
      let input = path.join(root, "bad.db");
      if (bad === "corrupt") await writeFile(input, "not sqlite");
      if (bad === "empty") await writeFile(input, "");
      if (bad === "foreign-key") {
        db.pragma("foreign_keys = OFF");
        db.exec("INSERT INTO children VALUES(2,99)");
        input = source;
      }
      const destination = path.join(root, "not-created.db");
      const result = action === "backup" ? run(backupScript, [destination], input)
        : run(restoreScript, [input, destination]);
      assert.notEqual(result.status, 0);
      assert.equal((await readdir(root)).includes("not-created.db"), false);
      assert.equal((await readdir(root)).some(name => name.startsWith(".goal-coach-snapshot-")), false);
    });
  }
}
