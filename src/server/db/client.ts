import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type AppDatabase = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

export function createDatabase(path: string): AppDatabase {
  const isMemoryDatabase = path === ":memory:";

  if (!isMemoryDatabase) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const client = new Database(path);

  try {
    client.pragma("foreign_keys = ON");
    if (!isMemoryDatabase) {
      client.pragma("journal_mode = WAL");
    }

    return drizzle(client, { schema });
  } catch (error) {
    client.close();
    throw error;
  }
}
