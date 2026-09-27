import { z } from "zod";
import * as d from "@/core/domain/contracts";
import type { PlanDiff } from "@/core/planning/plan-diff";
import type { NextActionResult } from "@/core/planning/next-action";
import type { Progress } from "@/core/planning/progress";

export const QWEN_PRIMARY_MODEL = "qwen3.7-flash-2026-07-15";
export const QWEN_FALLBACK_MODEL = "qwen3.7-plus-2026-05-26";
export const GOAL_REVIEW_REQUEST_MESSAGE = "请根据已记录的执行情况生成目标复盘。";

const uuid = z.string().uuid();
const version = z.number().int().positive();
const text = z.string().trim().min(1);

export const ProgressSchema: z.ZodType<Progress> = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
}).strict();
export type { Progress };

export const PublicSettingsSchema = d.AppSettingSchema.omit({ ownerId: true }).extend({
  apiKeyConfigured: z.boolean(),
}).strict();
export type PublicSettings = z.infer<typeof PublicSettingsSchema>;

export const ModelReadinessSchema = z.object({
  provider: d.ModelProviderSchema,
  configured: z.boolean(),
  liveVerified: z.boolean(),
  status: z.enum(["mock_selected", "configuration_missing", "configured_not_verified"]),
  models: z.object({ primary: text, fallback: text.nullable() }).strict(),
}).strict();
export type ModelReadiness = z.infer<typeof ModelReadinessSchema>;

const managedPreferenceFields = {
  id: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  version: true,
} as const;
export const UserPreferenceCreateInputSchema = d.UserPreferenceSchema.omit(managedPreferenceFields).strict();
export type UserPreferenceCreateInput = z.infer<typeof UserPreferenceCreateInputSchema>;
export const SettingsUpdateSchema = PublicSettingsSchema.pick({
  provider: true,
  fallbackEnabled: true,
  dailyInputTokenLimit: true,
  dailyOutputTokenLimit: true,
}).partial().extend({ expectedVersion: version, privacyAccepted: z.boolean().optional(), privacyProvider: d.ModelProviderSchema.optional(), privacyPolicyVersion: text.optional() }).strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
export const PREFERRED_TIME_WINDOW_MAX_LENGTH = 120;
export const EFFECTIVE_STRATEGIES_MAX_COUNT = 10;
export const EFFECTIVE_STRATEGY_MAX_LENGTH = 240;
export const PreferredTimeWindowInputSchema = text.max(PREFERRED_TIME_WINDOW_MAX_LENGTH).nullable();
export const EffectiveStrategiesInputSchema = z.array(text.max(EFFECTIVE_STRATEGY_MAX_LENGTH)).max(EFFECTIVE_STRATEGIES_MAX_COUNT);
export const PreferencesUpdateSchema = UserPreferenceCreateInputSchema.extend({
  preferredTimeWindow: PreferredTimeWindowInputSchema,
  effectiveStrategies: EffectiveStrategiesInputSchema,
}).partial().extend({ expectedVersion: version }).strict();
export type PreferencesUpdate = z.infer<typeof PreferencesUpdateSchema>;

export const GoalSummarySchema = z.object(d.GoalSchema.shape)
  .pick({ id: true, title: true, category: true, status: true, agentState: true, updatedAt: true })
  .extend({ progress: ProgressSchema })
  .strict();
export type GoalSummary = z.infer<typeof GoalSummarySchema>;

export const ContractAssumptionSchema = z.object({
  field: z.enum(["deadline", "weeklyMinutes", "constraints", "motivation"]),
  reason: text,
}).strict();
export type ContractAssumption = z.infer<typeof ContractAssumptionSchema>;

export function validateContractAssumptions(
  value: { contract: d.GoalInput; assumptions: ContractAssumption[] },
  context: z.RefinementCtx,
): void {
  if (
    new Set(value.assumptions.map(item => item.field)).size !== value.assumptions.length
    || value.assumptions.some(item => value.contract[item.field] === null)
  ) {
    context.addIssue({ code: "custom", message: "Assumptions must name unique non-null contract fields" });
  }
}

export const GoalContractDraftPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  baseGoalVersion: version,
  contract: d.GoalInputSchema,
  assumptions: z.array(ContractAssumptionSchema),
}).strict().superRefine(validateContractAssumptions);
export type GoalContractDraftPayload = z.infer<typeof GoalContractDraftPayloadSchema>;

export const BlockerAdviceSchema = z.object({
  minimumNextStep: text,
  explanation: text,
  taskId: uuid.nullable(),
  blockerCategory: d.BlockerCategorySchema,
}).strict();
export type BlockerAdvice = z.infer<typeof BlockerAdviceSchema>;

export const AgentTurnResultSchema = z.object({
  message: text,
  state: d.AgentStateSchema,
  draftId: uuid.optional(),
  advice: BlockerAdviceSchema.optional(),
  adviceGoalVersion: z.number().int().positive().optional(),
  persistedChange: z.boolean(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    modelCalls: z.number().int().min(0).max(4),
    toolCalls: z.number().int().min(0).max(3),
  }).strict(),
}).strict();
export type AgentTurnResult = z.infer<typeof AgentTurnResultSchema>;

export const TaskCreateInputSchema = z.object(d.TaskSchema.shape).pick({
  id: true,
  title: true,
  action: true,
  doneCriteria: true,
  evidenceType: true,
  estimateMinutes: true,
  dueAt: true,
  dependencyIds: true,
}).strict();
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const ExecutionResetSchema = z.object({
  taskKey: uuid,
  reason: z.enum(["completion_meaning_changed", "prerequisite_reset"]),
}).strict();
export type ExecutionReset = z.infer<typeof ExecutionResetSchema>;

export const PlanDiffSchema: z.ZodType<PlanDiff> = z.object({
  added: z.array(uuid),
  removed: z.array(uuid),
  moved: z.array(uuid),
  changed: z.array(uuid),
}).strict();

export const PlanMilestonesSchema = z.array(text).min(1)
  .refine(values => new Set(values).size === values.length, "Milestones must be distinct");
export type PlanMilestones = z.infer<typeof PlanMilestonesSchema>;

export const PlanRevisionPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  milestones: PlanMilestonesSchema,
  base: z.object({ planVersionId: uuid.nullable(), goalVersion: version }).strict(),
  changeReason: text.nullable(),
  changeSource: d.PlanChangeSourceSchema,
  tasks: z.array(TaskCreateInputSchema),
  executionResets: z.array(ExecutionResetSchema),
  diff: PlanDiffSchema,
}).strict().superRefine((payload, context) => {
  const keys = new Set(payload.tasks.map(task => task.id));
  const fail = () => context.addIssue({ code: "custom", message: "Invalid revision task graph or reset keys" });
  if (
    keys.size !== payload.tasks.length
    || new Set(payload.executionResets.map(reset => reset.taskKey)).size !== payload.executionResets.length
    || payload.executionResets.some(reset => !keys.has(reset.taskKey))
  ) fail();
  const byId = new Map(payload.tasks.map(task => [task.id, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(key: string): boolean {
    if (visiting.has(key) || !keys.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    const dependencies = byId.get(key)!.dependencyIds;
    if (new Set(dependencies).size !== dependencies.length || !dependencies.every(visit)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  }
  if (!payload.tasks.every(task => visit(task.id))) fail();
});
export type PlanRevisionPayload = z.infer<typeof PlanRevisionPayloadSchema>;

export const PlanRevisionEnvelopeSchema = z.object({
  added: z.array(uuid),
  removed: z.array(uuid),
  moved: z.array(uuid),
  changed: z.array(uuid),
  revision: z.object({
    schemaVersion: z.literal(2),
    draftArtifactId: uuid,
    draftArtifactVersion: version,
    payload: PlanRevisionPayloadSchema,
    taskMap: z.array(z.object({ draftKey: uuid, sourceTaskId: uuid.nullable(), storedTaskId: uuid }).strict()),
    evidenceMap: z.array(z.object({ sourceEvidenceId: uuid, copiedEvidenceId: uuid }).strict()),
  }).strict(),
}).strict().superRefine((envelope, context) => {
  for (const field of ["added", "removed", "moved", "changed"] as const) {
    if (JSON.stringify(envelope[field]) !== JSON.stringify(envelope.revision.payload.diff[field])) {
      context.addIssue({ code: "custom", message: "Display diff differs from sealed payload" });
    }
  }
  const { taskMap, evidenceMap, payload } = envelope.revision;
  const fail = () => context.addIssue({ code: "custom", message: "Invalid revision identity or evidence mapping" });
  const proposedKeys = new Set(payload.tasks.map(task => task.id));
  if (taskMap.length && taskMap.length !== proposedKeys.size) fail();
  if (
    new Set(taskMap.map(mapping => mapping.draftKey)).size !== taskMap.length
    || new Set(taskMap.map(mapping => mapping.storedTaskId)).size !== taskMap.length
  ) fail();
  if (taskMap.some(mapping => !proposedKeys.has(mapping.draftKey) || proposedKeys.has(mapping.storedTaskId) || (mapping.sourceTaskId !== null && mapping.sourceTaskId !== mapping.draftKey))) fail();
  if (
    new Set(evidenceMap.map(mapping => mapping.sourceEvidenceId)).size !== evidenceMap.length
    || new Set(evidenceMap.map(mapping => mapping.copiedEvidenceId)).size !== evidenceMap.length
    || evidenceMap.some(mapping => mapping.sourceEvidenceId === mapping.copiedEvidenceId)
  ) fail();
});
export type PlanRevisionEnvelope = z.infer<typeof PlanRevisionEnvelopeSchema>;

export const StoredPlanSchema = d.PlanVersionSchema.extend({ diff: PlanRevisionEnvelopeSchema }).strict();
export type StoredPlan = z.infer<typeof StoredPlanSchema>;

export const ExportBundleSchema = z.object({
  schemaVersion: z.literal(2),
  exportedAt: z.iso.datetime({ offset: true }),
  goals: z.array(d.GoalSchema),
  tasks: z.array(d.TaskSchema),
  planVersions: z.array(StoredPlanSchema),
  checkIns: z.array(d.CheckInSchema),
  evidence: z.array(d.TaskEvidenceSchema),
  preferences: z.array(d.UserPreferenceSchema),
  conversationSummaries: z.array(d.ConversationSummarySchema),
  conversationMessages: z.array(d.ConversationMessageSchema),
}).strict();
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export const DeletedCountsSchema = z.object(Object.fromEntries([
  "evidence", "checkIns", "undoRecords", "conversationSummaries", "conversationMessages",
  "agentRuns", "auditEvents", "draftArtifacts", "tasks", "planVersions", "operations",
  "goals", "approvalGrants", "preferences", "settings",
].map(key => [key, z.number().int().nonnegative()]))).strict();
export type DeletedCounts = z.infer<typeof DeletedCountsSchema>;
export const ClearDataResultSchema = z.object({ deletedCounts: DeletedCountsSchema }).strict();
export type ClearDataResult = z.infer<typeof ClearDataResultSchema>;

export const ReviewReflectionSchema = z.object({
  stale: z.boolean().default(false),
  message: text,
  generatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type ReviewReflection = z.infer<typeof ReviewReflectionSchema>;

const ContractDraftArtifactSchema = d.DraftArtifactSchema.extend({
  kind: z.literal("goal_contract"), payload: GoalContractDraftPayloadSchema, status: z.literal("pending"),
}).strict();
export type ContractDraftArtifact = z.infer<typeof ContractDraftArtifactSchema>;
const PlanDraftArtifactSchema = d.DraftArtifactSchema.extend({
  kind: z.literal("plan"), payload: PlanRevisionPayloadSchema, status: z.literal("pending"),
}).strict();
export type PlanDraftArtifact = z.infer<typeof PlanDraftArtifactSchema>;
const ReplanDraftArtifactSchema = d.DraftArtifactSchema.extend({
  kind: z.literal("replan"), payload: PlanRevisionPayloadSchema, status: z.literal("pending"),
}).strict();
export type ReplanDraftArtifact = z.infer<typeof ReplanDraftArtifactSchema>;

export const PendingDraftSchema = z.discriminatedUnion("kind", [ContractDraftArtifactSchema, PlanDraftArtifactSchema, ReplanDraftArtifactSchema]);
export type PendingDraft = z.infer<typeof PendingDraftSchema>;

export const NextActionSchema: z.ZodType<NextActionResult> = z.object({
  task: d.TaskSchema,
  suggestedSliceMinutes: z.number().positive(),
  reasons: z.array(text),
}).strict();

export const GoalWorkspaceSchema = z.object({
  canUndo: z.boolean(),
  undoCandidate: z.object({ id: uuid, kind: z.enum(["task_execution", "check_in"]), label: text }).strict().nullable(),
  undoUnavailableReason: text.nullable(),
  goal: d.GoalSchema,
  currentPlan: StoredPlanSchema.extend({ milestones: PlanMilestonesSchema }).nullable(),
  tasks: z.array(d.TaskSchema),
  evidence: z.array(d.TaskEvidenceSchema),
  checkIns: z.array(d.CheckInSchema),
  effectiveCheckIns: z.array(d.CheckInSchema),
  pendingDrafts: z.array(PendingDraftSchema),
  planHistory: z.array(StoredPlanSchema),
  conversation: z.object({ summary: d.ConversationSummarySchema.nullable(), recentMessages: z.array(d.ConversationMessageSchema).max(6) }).strict(),
  reviewReflection: ReviewReflectionSchema.nullable(),
  preference: d.UserPreferenceSchema.nullable(),
  progress: ProgressSchema,
  nextAction: NextActionSchema.nullable(),
  replanTriggers: z.array(z.object({
    code: z.enum(["actual_overrun", "repeated_skip", "capacity_overload", "availability_reduced", "unresolved_blocker"]),
    taskId: uuid.optional(),
    reason: text,
  }).strict()),
}).strict();
export type GoalWorkspace = z.infer<typeof GoalWorkspaceSchema>;
export { UndoResultSchema, type UndoResult } from "@/core/domain/contracts";
export const UndoBindingSchema = z.object({ expectedUndoId: uuid.optional(), expectedGoalVersion: z.number().int().positive().optional() }).strict();
export const pairedUndoBinding = (value: z.infer<typeof UndoBindingSchema>) => (value.expectedUndoId === undefined) === (value.expectedGoalVersion === undefined);

export const CreateGoalResultSchema = z.object({ goal: d.GoalSchema, state: z.literal("intake") }).strict();
export type CreateGoalResult = z.infer<typeof CreateGoalResultSchema>;
export const SavedContractDraftSchema = ContractDraftArtifactSchema;
export const ApprovedContractResultSchema = z.object({ goal: d.GoalSchema.strict() }).strict();
export const ApprovedPlanResultSchema = z.object({ plan: StoredPlanSchema, tasks: z.array(d.TaskSchema.strict()) }).strict();
export type ApprovedContractResult = z.infer<typeof ApprovedContractResultSchema>;
export type ApprovedPlanResult = z.infer<typeof ApprovedPlanResultSchema>;
