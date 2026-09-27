import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createDatabase } from "./client";
import { migrateDatabase } from "./migrate";
import { LOCAL_OWNER_ID } from "../security/local-owner";

test("auth migration adds tables while retaining legacy rows and owner identities byte for byte", () => {
  const db = createDatabase(":memory:");
  try {
    db.$client.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)");
    for (const [file, timestamp] of [["0000_initial", 1789478301933], ["0001_unified_undo", 1789718400000]] as const) {
      const sql = readFileSync(`drizzle/${file}.sql`, "utf8");
      db.$client.exec(sql);
      db.$client.prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)").run(createHash("sha256").update(sql).digest("hex"), timestamp);
    }
    db.$client.prepare("INSERT INTO goals(id,owner_id,title,category,status,created_at,updated_at) VALUES ('legacy',?,'existing synthetic goal','other','active',1,1)").run(LOCAL_OWNER_ID);
    db.$client.prepare("INSERT INTO app_settings(id,owner_id,privacy_accepted_at,provider,model,fallback_enabled,daily_input_token_limit,daily_output_token_limit,created_at,updated_at) VALUES ('legacy-setting',?,?, 'qwen','qwen3.7-flash-2026-07-15',0,100,100,1,1)").run(LOCAL_OWNER_ID, 1789478301933);
    const before = db.$client.prepare("SELECT * FROM goals").all();
    migrateDatabase(db);
    migrateDatabase(db);
    expect(db.$client.prepare("SELECT * FROM goals").all()).toEqual(before);
    expect(db.$client.prepare("SELECT privacy_accepted_at,privacy_provider,privacy_policy_version FROM app_settings WHERE id='legacy-setting'").get())
      .toEqual({ privacy_accepted_at: 1789478301933, privacy_provider: null, privacy_policy_version: null });
    expect(db.$client.prepare("SELECT count(*) AS count FROM auth_users").get()).toEqual({ count: 0 });
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 5 });
  } finally { db.$client.close(); }
});
