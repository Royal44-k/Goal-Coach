import { link, lstat, mkdtemp, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

function validate(database) {
  if (database.pragma("integrity_check", { simple: true }) !== "ok"
    || database.pragma("foreign_key_check").length !== 0
    || !database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
    throw new Error("数据库校验失败");
  }
}

/** Publish a validated SQLite snapshot exclusively; never overwrite or delete a caller's output. */
export async function copyValidatedDatabase(source, destination) {
  if (!source?.trim() || !destination?.trim() || source === ":memory:" || destination === ":memory:") {
    throw new Error("需要源文件和全新目标路径");
  }
  const input = path.resolve(source);
  const output = path.resolve(destination);
  if (!(await lstat(input)).isFile()) throw new Error("源必须是普通数据库文件");
  try {
    await lstat(output);
    throw new Error("目标已存在，拒绝覆盖");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const database = new Database(input, { readonly: true, fileMustExist: true });
  let temporaryDirectory;
  try {
    validate(database);
    // Same parent filesystem makes hard-link publication atomic and exclusive.
    // Only this private mkdtemp directory is ever removed on failure.
    temporaryDirectory = await mkdtemp(path.join(path.dirname(output), ".goal-coach-snapshot-"));
    await chmod(temporaryDirectory, 0o700);
    const snapshot = path.join(temporaryDirectory, "snapshot.db");
    await database.backup(snapshot);
    await chmod(snapshot, 0o600);
    // Backup inherits WAL mode. Convert ONLY our owned snapshot so a later
    // readonly mount never needs to create -wal/-shm beside the published file.
    const standalone = new Database(snapshot, { fileMustExist: true });
    try {
      if (standalone.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
        throw new Error("无法生成独立数据库快照");
      }
    } finally { standalone.close(); }
    const check = new Database(snapshot, { readonly: true, fileMustExist: true });
    try { validate(check); } finally { check.close(); }
    await link(snapshot, output);
  } finally {
    database.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const task = args.length === 1
    ? copyValidatedDatabase(process.env.DATABASE_PATH, args[0])
    : Promise.reject(new Error("参数错误"));
  task.then(() => console.info("数据库备份完成；已校验完整性与外键。"))
    .catch(() => {
      console.error("备份失败。请检查 DATABASE_PATH、源完整性、目标目录权限，并使用不存在的新目标文件。原有目标不会被覆盖。");
      process.exitCode = 1;
    });
}
