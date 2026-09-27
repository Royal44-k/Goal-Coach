import { z } from "zod";

export const AgentStateSchema = z.enum([
  "intake",
  "clarifying",
  "contract_review",
  "planning",
  "plan_review",
  "active",
  "reviewing",
  "replanning",
  "paused",
  "completed",
  "failed_recoverable",
]);

export const GoalCategorySchema = z.enum(["learning", "light_work"]);
export const GoalStatusSchema = z.enum(["draft", "active", "paused", "completed", "archived"]);
export const TaskStatusSchema = z.enum(["todo", "doing", "blocked", "done", "skipped"]);
export const EvidenceTypeSchema = z.enum([
  "text",
  "file_metadata",
  "check_answer",
  "user_declaration",
]);
export const BlockerCategorySchema = z.enum([
  "cannot_start",
  "task_too_large",
  "insufficient_time",
  "missing_resource",
  "fear_of_error",
  "prerequisite_incomplete",
]);
export const DraftKindSchema = z.enum(["goal_contract", "plan", "replan"]);
export const DraftStatusSchema = z.enum(["pending", "approved", "rejected", "superseded"]);

export const PlanVersionStatusSchema = z.enum(["draft", "approved", "superseded", "rejected"]);
export const PlanChangeSourceSchema = z.enum(["user", "agent"]);
export const CheckInKindSchema = z.enum([
  "progress",
  "blocker",
  "availability_change",
  "evidence",
  "reflection",
]);
export const AgentRunStatusSchema = z.enum(["running", "succeeded", "failed"]);
export const OperationStatusSchema = z.enum(["pending", "succeeded", "failed"]);
export const ConversationRoleSchema = z.enum(["user", "assistant"]);
export const TaskGranularitySchema = z.enum(["small", "medium", "large"]);
export const ModelProviderSchema = z.enum(["mock", "qwen", "deepseek"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

const UuidSchema = z.string().uuid();
const DateTimeSchema = z.iso.datetime({ offset: true });
const DaySchema = z.iso.date();
const NonEmptyStringSchema = z.string().trim().min(1);
const PositiveMinutesSchema = z.number().int().positive();
const VersionSchema = z.number().int().min(1);
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: z.ZodType<Record<string, JsonValue>> = z.record(
  z.string(),
  JsonValueSchema,
);

const EntityFields = {
  id: UuidSchema,
  ownerId: UuidSchema,
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
  version: VersionSchema,
};

const GoalContractFields = {
  desiredOutcome: NonEmptyStringSchema.nullable(),
  definitionOfDone: NonEmptyStringSchema.nullable(),
  deadline: DaySchema.nullable(),
  weeklyMinutes: PositiveMinutesSchema.nullable(),
  constraints: z.array(NonEmptyStringSchema).nullable(),
  motivation: NonEmptyStringSchema.nullable(),
};

export const GoalSchema = z
  .object({
    ...EntityFields,
    title: NonEmptyStringSchema,
    category: GoalCategorySchema,
    status: GoalStatusSchema,
    agentState: AgentStateSchema,
    clarificationCount: z.number().int().min(0).max(3),
    currentPlanVersionId: UuidSchema.nullable(),
    ...GoalContractFields,
  })
  .superRefine((goal, context) => {
    if (goal.status === "draft") {
      return;
    }

    for (const field of [
      "desiredOutcome",
      "definitionOfDone",
      "deadline",
      "weeklyMinutes",
      "constraints",
      "motivation",
    ] as const) {
      if (goal[field] === null) {
        context.addIssue({
          code: "custom",
          message: "非草稿目标必须有完整目标契约。",
          path: [field],
        });
      }
    }
  });

export const GoalInputSchema = z
  .object({
    title: NonEmptyStringSchema,
    category: GoalCategorySchema,
    ...GoalContractFields,
  })
  .strict();

/** Approval completeness is independent of the Goal lifecycle status. */
export const CompleteGoalContractSchema = GoalInputSchema.extend({
  desiredOutcome: NonEmptyStringSchema, definitionOfDone: NonEmptyStringSchema,
  deadline: DaySchema, weeklyMinutes: PositiveMinutesSchema,
  constraints: z.array(NonEmptyStringSchema), motivation: NonEmptyStringSchema,
}).strict();

export const TaskSchema = z
  .object({
    ...EntityFields,
    goalId: UuidSchema,
    planVersionId: UuidSchema,
    title: NonEmptyStringSchema,
    action: NonEmptyStringSchema,
    doneCriteria: NonEmptyStringSchema,
    evidenceType: EvidenceTypeSchema,
    estimateMinutes: PositiveMinutesSchema,
    actualMinutes: PositiveMinutesSchema.nullable(),
    dueAt: DaySchema.nullable(),
    dependencyIds: z.array(UuidSchema),
    status: TaskStatusSchema,
  })
  .superRefine((task, context) => {
    if (task.dependencyIds.includes(task.id)) {
      context.addIssue({
        code: "custom",
        message: "任务不能依赖自身。",
        path: ["dependencyIds"],
      });
    }
  });

export const PlanVersionSchema = z.object({
  ...EntityFields,
  goalId: UuidSchema,
  number: z.number().int().min(1),
  status: PlanVersionStatusSchema,
  changeReason: NonEmptyStringSchema.nullable(),
  changeSource: PlanChangeSourceSchema,
  diff: JsonObjectSchema,
  approvedAt: DateTimeSchema.nullable(),
});

export const DraftArtifactSchema = z.object({
  ...EntityFields,
  goalId: UuidSchema,
  kind: DraftKindSchema,
  payload: JsonObjectSchema,
  contentHash: ContentHashSchema,
  status: DraftStatusSchema,
});

export const CheckInSchema = z
  .object({
    ...EntityFields,
    goalId: UuidSchema,
    taskId: UuidSchema.nullable(),
    kind: CheckInKindSchema,
    blockerCategory: BlockerCategorySchema.nullable(),
    note: NonEmptyStringSchema.nullable(),
    minutesSpent: PositiveMinutesSchema.nullable(),
    availableWeeklyMinutes: PositiveMinutesSchema.nullable(),
    withdrawnAt: DateTimeSchema.nullable().default(null),
  })
  .superRefine((checkIn, context) => {
    if (checkIn.kind === "blocker" && checkIn.blockerCategory === null) {
      context.addIssue({
        code: "custom",
        message: "阻塞记录必须选择阻塞类别。",
        path: ["blockerCategory"],
      });
    }

    if (checkIn.kind === "availability_change" && checkIn.availableWeeklyMinutes === null) {
      context.addIssue({
        code: "custom",
        message: "时间变化记录必须提供每周可用分钟数。",
        path: ["availableWeeklyMinutes"],
      });
    }

    const hasRelevantValue = {
      progress:
        checkIn.taskId !== null || checkIn.note !== null || checkIn.minutesSpent !== null,
      blocker:
        checkIn.taskId !== null || checkIn.note !== null || checkIn.blockerCategory !== null,
      availability_change: checkIn.availableWeeklyMinutes !== null,
      evidence: checkIn.taskId !== null || checkIn.note !== null,
      reflection: checkIn.note !== null,
    }[checkIn.kind];

    if (!hasRelevantValue) {
      context.addIssue({
        code: "custom",
        message: "签到记录必须提供与类型相关的内容。",
      });
    }
  });

export const TaskEvidenceSchema = z.object({
  ...EntityFields,
  goalId: UuidSchema,
  taskId: UuidSchema,
  type: EvidenceTypeSchema,
  text: NonEmptyStringSchema.nullable(),
  fileName: NonEmptyStringSchema.nullable(),
  fileSize: z.number().int().nonnegative().nullable(),
  mimeType: NonEmptyStringSchema.nullable(),
});

export const AgentRunSchema = z.object({
  ...EntityFields,
  goalId: UuidSchema,
  startState: AgentStateSchema,
  endState: AgentStateSchema.nullable(),
  status: AgentRunStatusSchema,
  model: NonEmptyStringSchema,
  inputTokenCount: z.number().int().nonnegative(),
  outputTokenCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  errorCode: NonEmptyStringSchema.nullable(),
});

export const ApprovalGrantSchema = z
  .object({
    ...EntityFields,
    subjectId: UuidSchema,
    contentHash: ContentHashSchema,
    allowedTool: NonEmptyStringSchema,
    expiresAt: DateTimeSchema,
    usedAt: DateTimeSchema.nullable(),
  })
  .superRefine((grant, context) => {
    const lifetimeMs = Date.parse(grant.expiresAt) - Date.parse(grant.createdAt);

    if (lifetimeMs <= 0 || lifetimeMs > 15 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        message: "确认授权的有效期必须大于零且不超过十五分钟。",
        path: ["expiresAt"],
      });
    }
  });

export const OperationSchema = z.object({
  ...EntityFields,
  goalId: UuidSchema.nullable(),
  operationId: NonEmptyStringSchema,
  toolName: NonEmptyStringSchema,
  parameterHash: ContentHashSchema,
  status: OperationStatusSchema,
  result: JsonObjectSchema.nullable(),
});

export const UndoRecordSchema = z.object({
  ...EntityFields,
  goalId: UuidSchema,
  kind: z.enum(["task_execution", "check_in"]),
  taskId: UuidSchema.nullable(),
  checkInId: UuidSchema.nullable(),
  ordinal: z.number().int().positive(),
  conversationFence: z.object({ revision: z.number().int().positive(), throughMessageId: UuidSchema.nullable(), throughAgentTurnOperationId: UuidSchema.nullable() }).strict().nullable(),
  forwardPatch: JsonObjectSchema,
  reversePatch: JsonObjectSchema,
  undoneAt: DateTimeSchema.nullable(),
});

export const UndoResultSchema = z.union([
  z.object({ task: TaskSchema }).strict(),
  z.object({ checkIn: CheckInSchema }).strict(),
]);
export type UndoResult = z.infer<typeof UndoResultSchema>;

export const ConversationMessageSchema = z.object({
  ...EntityFields,
  goalId: UuidSchema,
  role: ConversationRoleSchema,
  content: NonEmptyStringSchema,
});

export const ConversationSummarySchema = z.object({
  ...EntityFields,
  goalId: UuidSchema,
  throughMessageId: UuidSchema,
  content: NonEmptyStringSchema,
});

export const UserPreferenceSchema = z.object({
  ...EntityFields,
  taskGranularity: TaskGranularitySchema,
  preferredTimeWindow: NonEmptyStringSchema.nullable(),
  estimateBias: z.number().positive(),
  commonBlockers: z.array(BlockerCategorySchema),
  effectiveStrategies: z.array(NonEmptyStringSchema),
});

export const AuditEventSchema = z.object({
  id: UuidSchema,
  ownerId: UuidSchema,
  goalId: UuidSchema.nullable(),
  type: NonEmptyStringSchema,
  entityType: NonEmptyStringSchema,
  entityId: UuidSchema,
  detail: JsonObjectSchema,
  createdAt: DateTimeSchema,
  version: VersionSchema,
});

export const AppSettingSchema = z.object({
  ...EntityFields,
  privacyAcceptedAt: DateTimeSchema.nullable(),
  privacyProvider: ModelProviderSchema.nullable(),
  privacyPolicyVersion: NonEmptyStringSchema.nullable(),
  provider: ModelProviderSchema,
  model: NonEmptyStringSchema,
  fallbackEnabled: z.boolean(),
  dailyInputTokenLimit: z.number().int().positive(),
  dailyOutputTokenLimit: z.number().int().positive(),
});

export type AgentState = z.infer<typeof AgentStateSchema>;
export type GoalCategory = z.infer<typeof GoalCategorySchema>;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type BlockerCategory = z.infer<typeof BlockerCategorySchema>;
export type DraftKind = z.infer<typeof DraftKindSchema>;
export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type GoalInput = z.infer<typeof GoalInputSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type PlanVersion = z.infer<typeof PlanVersionSchema>;
export type DraftArtifact = z.infer<typeof DraftArtifactSchema>;
export type CheckIn = z.infer<typeof CheckInSchema>;
export type TaskEvidence = z.infer<typeof TaskEvidenceSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type UndoRecord = z.infer<typeof UndoRecordSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type UserPreference = z.infer<typeof UserPreferenceSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AppSetting = z.infer<typeof AppSettingSchema>;
