import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { z } from "zod";
import { createDatabase, type AppDatabase } from "./client";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const DatabasePathSchema = z.string().trim().min(1);

export function migrateDatabase(database: AppDatabase): void {
  migrate(database, { migrationsFolder });
}

function loadLocalEnvironment(): void {
  const environmentPath = resolve(".env.local");
  if (existsSync(environmentPath)) {
    process.loadEnvFile(environmentPath);
  }
}

function runMigrationCli(): void {
  let database: AppDatabase | undefined;

  try {
    loadLocalEnvironment();
    const databasePath = DatabasePathSchema.parse(process.env.DATABASE_PATH);
    database = createDatabase(databasePath);
    migrateDatabase(database);
    console.info("本地数据库迁移完成。");
  } catch {
    console.error("数据库迁移失败。请检查本地数据库配置后重试。");
    process.exitCode = 1;
  } finally {
    database?.$client.close();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (executedPath === import.meta.url) {
  runMigrationCli();
}
