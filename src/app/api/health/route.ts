import Database from "better-sqlite3";
import { loadAuthConfig } from "@/server/auth/auth-config";
import { loadServerEnv, requireQwenConfig } from "@/server/config/env";
import { requireDeepSeekConfig } from "@/server/config/deepseek-config";
import { dailyAgentTurnLimit } from "@/server/agent/admission-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Local readiness only: no migrations, database creation or provider requests.
export function GET(): Response {
  let database: Database.Database | undefined;
  let ready = false;
  try {
    loadAuthConfig();
    const config = loadServerEnv();
    if (config.provider === "qwen") requireQwenConfig(config);
    if (config.provider === "deepseek") requireDeepSeekConfig(config.deepseek);
    dailyAgentTurnLimit();
    database = new Database(config.databasePath, { readonly: true, fileMustExist: true, timeout: 1000 });
    // Unlike SELECT 1, reading sqlite_schema actually checks the database file.
    database.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    ready = true;
  } catch {
    // Do not expose paths, credentials, SQLite diagnostics, or account metadata.
  } finally {
    database?.close();
  }
  return Response.json({ ok: ready }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
