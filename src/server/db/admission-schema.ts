import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
/** Kept outside business export/clear; also supports the local-mode UUID. */
export const agentDailyAdmissions = sqliteTable("agent_daily_admissions", {
  ownerId: text("owner_id").notNull(), day: text("day").notNull(), count: integer("count").notNull(),
}, t => [primaryKey({ columns: [t.ownerId, t.day] }), check("agent_daily_admissions_count_check", sql`${t.count} >= 0`)]);
/** Content-free billing receipts survive deletion and deduplicate late provider returns. */
export const accountModelUsage = sqliteTable("account_model_usage", {
  ownerId: text("owner_id").notNull(), attemptId: text("attempt_id").notNull(), day: text("day").notNull(),
  inputTokens: integer("input_tokens").notNull(), outputTokens: integer("output_tokens").notNull(),
}, t => [primaryKey({ columns: [t.ownerId, t.attemptId] }), check("account_model_usage_tokens_check", sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0`)]);
