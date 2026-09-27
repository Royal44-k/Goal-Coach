import type {
  AgentState,
  BlockerCategory,
  DraftKind,
  DraftStatus,
  EvidenceType,
  GoalCategory,
  GoalStatus,
  JsonValue,
  TaskStatus,
} from "@/core/domain/contracts";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export { authUsers, authInvites, authSessions, authThrottles } from "./auth-schema";

type JsonObject = Record<string, JsonValue>;

export const goals = sqliteTable(
  "goals",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    category: text("category").$type<GoalCategory>().notNull(),
    status: text("status").$type<GoalStatus>().notNull(),
    agentState: text("agent_state").$type<AgentState>().notNull().default("intake"),
    clarificationCount: integer("clarification_count").notNull().default(0),
    currentPlanVersionId: text("current_plan_version_id").references(
      (): AnySQLiteColumn => planVersions.id,
    ),
    desiredOutcome: text("desired_outcome"),
    definitionOfDone: text("definition_of_done"),
    deadline: text("deadline"),
    weeklyMinutes: integer("weekly_minutes"),
    constraints: text("constraints", { mode: "json" }).$type<string[]>(),
    motivation: text("motivation"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("goals_owner_idx").on(table.ownerId)],
);

export const planVersions = sqliteTable(
  "plan_versions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    number: integer("number").notNull(),
    status: text("status")
      .$type<"draft" | "approved" | "superseded" | "rejected">()
      .notNull(),
    changeReason: text("change_reason"),
    changeSource: text("change_source").$type<"user" | "agent">().notNull(),
    diff: text("diff", { mode: "json" }).$type<JsonObject>().notNull(),
    approvedAt: integer("approved_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("plan_versions_owner_idx").on(table.ownerId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planVersionId: text("plan_version_id")
      .notNull()
      .references(() => planVersions.id),
    title: text("title").notNull(),
    action: text("action").notNull(),
    doneCriteria: text("done_criteria").notNull(),
    evidenceType: text("evidence_type").$type<EvidenceType>().notNull(),
    estimateMinutes: integer("estimate_minutes").notNull(),
    actualMinutes: integer("actual_minutes"),
    dueAt: text("due_at"),
    dependencyIds: text("dependency_ids", { mode: "json" }).$type<string[]>().notNull(),
    status: text("status").$type<TaskStatus>().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("tasks_owner_idx").on(table.ownerId)],
);

export const draftArtifacts = sqliteTable(
  "draft_artifacts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    kind: text("kind").$type<DraftKind>().notNull(),
    payload: text("payload", { mode: "json" }).$type<JsonObject>().notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").$type<DraftStatus>().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("draft_artifacts_owner_idx").on(table.ownerId)],
);

export const checkIns = sqliteTable(
  "check_ins",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    taskId: text("task_id").references(() => tasks.id),
    kind: text("kind")
      .$type<"progress" | "blocker" | "availability_change" | "evidence" | "reflection">()
      .notNull(),
    blockerCategory: text("blocker_category").$type<BlockerCategory>(),
    note: text("note"),
    minutesSpent: integer("minutes_spent"),
    availableWeeklyMinutes: integer("available_weekly_minutes"),
    withdrawnAt: integer("withdrawn_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("check_ins_owner_idx").on(table.ownerId)],
);

export const taskEvidence = sqliteTable(
  "task_evidence",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    type: text("type").$type<EvidenceType>().notNull(),
    text: text("text"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("task_evidence_owner_idx").on(table.ownerId)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    startState: text("start_state").$type<AgentState>().notNull(),
    endState: text("end_state").$type<AgentState>(),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull(),
    model: text("model").notNull(),
    inputTokenCount: integer("input_token_count").notNull(),
    outputTokenCount: integer("output_token_count").notNull(),
    toolCallCount: integer("tool_call_count").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("agent_runs_owner_idx").on(table.ownerId)],
);

export const approvalGrants = sqliteTable(
  "approval_grants",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    subjectId: text("subject_id").notNull(),
    contentHash: text("content_hash").notNull(),
    allowedTool: text("allowed_tool").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("approval_grants_owner_idx").on(table.ownerId)],
);

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id").references(() => goals.id),
    operationId: text("operation_id").notNull(),
    toolName: text("tool_name").notNull(),
    parameterHash: text("parameter_hash").notNull(),
    status: text("status").$type<"pending" | "succeeded" | "failed">().notNull(),
    result: text("result", { mode: "json" }).$type<JsonObject>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("operations_owner_idx").on(table.ownerId),
    uniqueIndex("operations_operation_id_unique").on(table.operationId),
  ],
);

export const undoRecords = sqliteTable(
  "undo_records",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    kind: text("kind").$type<"task_execution" | "check_in">().notNull(),
    taskId: text("task_id").references(() => tasks.id),
    checkInId: text("check_in_id").references(() => checkIns.id),
    ordinal: integer("ordinal").notNull(),
    conversationFence: text("conversation_fence", { mode: "json" }).$type<{ revision: number; throughMessageId: string | null; throughAgentTurnOperationId: string | null }>(),
    forwardPatch: text("forward_patch", { mode: "json" }).$type<JsonObject>().notNull(),
    reversePatch: text("reverse_patch", { mode: "json" }).$type<JsonObject>().notNull(),
    undoneAt: integer("undone_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("undo_records_owner_idx").on(table.ownerId),
    uniqueIndex("undo_records_goal_ordinal_unique").on(table.ownerId, table.goalId, table.ordinal),
    uniqueIndex("undo_records_check_in_unique").on(table.checkInId),
    check("undo_records_target_check", sql`(${table.kind} = 'task_execution' AND ${table.taskId} IS NOT NULL AND ${table.checkInId} IS NULL) OR (${table.kind} = 'check_in' AND ${table.taskId} IS NULL AND ${table.checkInId} IS NOT NULL)`),
    check("undo_records_ordinal_check", sql`${table.ordinal} > 0`),
  ],
);

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("conversation_messages_owner_idx").on(table.ownerId)],
);

export const conversationSummaries = sqliteTable(
  "conversation_summaries",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    throughMessageId: text("through_message_id")
      .notNull()
      .references(() => conversationMessages.id),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("conversation_summaries_owner_idx").on(table.ownerId)],
);

export const userPreferences = sqliteTable(
  "user_preferences",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    taskGranularity: text("task_granularity")
      .$type<"small" | "medium" | "large">()
      .notNull(),
    preferredTimeWindow: text("preferred_time_window"),
    estimateBias: real("estimate_bias").notNull(),
    commonBlockers: text("common_blockers", { mode: "json" })
      .$type<BlockerCategory[]>()
      .notNull(),
    effectiveStrategies: text("effective_strategies", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("user_preferences_owner_idx").on(table.ownerId)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    goalId: text("goal_id").references(() => goals.id),
    type: text("type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    detail: text("detail", { mode: "json" }).$type<JsonObject>().notNull(),
    createdAt: integer("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("audit_events_owner_idx").on(table.ownerId)],
);

export const appSettings = sqliteTable(
  "app_settings",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    privacyAcceptedAt: integer("privacy_accepted_at"),
    privacyProvider: text("privacy_provider").$type<"mock" | "qwen" | "deepseek">(),
    privacyPolicyVersion: text("privacy_policy_version"),
    provider: text("provider").$type<"mock" | "qwen" | "deepseek">().notNull(),
    model: text("model").notNull(),
    fallbackEnabled: integer("fallback_enabled", { mode: "boolean" }).notNull(),
    dailyInputTokenLimit: integer("daily_input_token_limit").notNull(),
    dailyOutputTokenLimit: integer("daily_output_token_limit").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("app_settings_owner_idx").on(table.ownerId)],
);
export { agentDailyAdmissions, accountModelUsage } from "./admission-schema";
