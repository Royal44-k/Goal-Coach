import { z } from "zod";
import { AgentStateSchema, GoalCategorySchema } from "@/core/domain/contracts";
import { toolContracts, type ToolName } from "@/server/agent/tool-contracts";

const toolNames = new Set(Object.keys(toolContracts));
export const EvalKindSchema = z.enum(["learning", "light_work", "ambiguous", "unrealistic", "out_of_scope"]);
export const ExpectedActionSchema = z.enum(["ask_one_question", "draft_contract", "negotiate_scope", "refuse_out_of_scope"]);
export const ActualActionSchema = z.union([ExpectedActionSchema, z.literal("unknown")]);
export const ToolNameSchema = z.custom<ToolName>(value => typeof value === "string" && toolNames.has(value));

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^(?:L\d{2}|W\d{2}|A\d{2}|U\d{2}|R\d{2})$/u),
  kind: EvalKindSchema,
  prompt: z.string().trim().min(1),
  expectedAction: ExpectedActionSchema,
  requiredConcepts: z.array(z.string().trim().min(1)),
  forbiddenPatterns: z.array(z.string().trim().min(1)),
  allowedTools: z.array(ToolNameSchema),
  forbiddenTools: z.array(ToolNameSchema),
  requiresApproval: z.boolean(),
}).strict().superRefine((item, context) => {
  if (item.requiredConcepts.length + item.forbiddenPatterns.length === 0)
    context.addIssue({ code: "custom", message: "At least one machine-checkable expectation is required" });
  if (new Set(item.allowedTools).size !== item.allowedTools.length || new Set(item.forbiddenTools).size !== item.forbiddenTools.length)
    context.addIssue({ code: "custom", message: "Tool lists must not contain duplicates" });
  if (item.allowedTools.some(tool => item.forbiddenTools.includes(tool)))
    context.addIssue({ code: "custom", message: "Allowed and forbidden tools must not overlap" });
  for (const [index, pattern] of item.forbiddenPatterns.entries()) {
    try { new RegExp(pattern, "u"); }
    catch { context.addIssue({ code: "custom", message: "Forbidden pattern must be valid Unicode RegExp", path: ["forbiddenPatterns", index] }); }
  }
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export const EvalCasesSchema = z.array(EvalCaseSchema).length(30).superRefine((items, context) => {
  if (new Set(items.map(item => item.id)).size !== items.length)
    context.addIssue({ code: "custom", message: "Evaluation case IDs must be unique" });
});

export const ProviderCallSchema = z.object({
  requestedModel: z.string().trim().min(1),
  advertisedTools: z.array(z.string()),
  proposedTools: z.array(z.string()),
  // Absent in historical artifacts; do not backfill evidence that was never captured.
  argumentDiagnostics: z.array(z.object({
    toolName: z.union([ToolNameSchema, z.literal("unknown")]),
    status: z.enum(["valid", "invalid_json", "invalid_arguments", "unknown_tool"]),
    issues: z.array(z.object({
      path: z.string(),
      code: z.string(),
      rule: z.enum(["unique_non_null_assumption_fields", "duplicate_assumption_field", "null_contract_assumption_field"]).nullable(),
    }).strict()),
  }).strict()).optional(),
  latencyMs: z.number().nonnegative(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict().nullable(),
  errorCode: z.string().trim().min(1).nullable(),
}).strict();

export const MachineChecksSchema = z.object({
  questionLimit: z.boolean(),
  forbiddenToolAbsence: z.boolean(),
  allowedToolSubset: z.boolean(),
  noUnauthorizedStructuralWrite: z.boolean(),
  noSecretLikeString: z.boolean(),
  noCrash: z.boolean(),
  expectedFinalAction: z.boolean(),
  requiredConceptsPresent: z.boolean(),
  forbiddenPatternsAbsent: z.boolean(),
  modelCallLimit: z.boolean(),
  executorLimit: z.boolean(),
  protectedToolsNotAdvertised: z.boolean(),
  draftIntegrity: z.boolean(),
  noUnexpectedDraft: z.boolean(),
}).strict();

export const EvaluationResultSchema = z.object({
  schemaVersion: z.literal(1),
  caseId: z.string().min(1),
  kind: EvalKindSchema,
  provider: z.enum(["mock", "qwen", "deepseek"]),
  goalCategory: GoalCategorySchema,
  expectedAction: ExpectedActionSchema,
  actualAction: ActualActionSchema,
  message: z.string().nullable(),
  draft: z.object({
    desiredOutcome: z.string().nullable(),
    definitionOfDone: z.string().nullable(),
    deadline: z.string().nullable(),
    weeklyMinutes: z.number().int().positive().nullable(),
  }).strict().nullable(),
  stageBefore: AgentStateSchema,
  stageAfter: AgentStateSchema.nullable(),
  proposedTools: z.array(z.string()),
  executorAttemptCount: z.number().int().nonnegative().max(3).nullable(),
  successfulMutationTools: z.array(z.string()),
  providerCalls: z.array(ProviderCallSchema).max(4),
  usage: z.object({
    knownInputTokens: z.number().int().nonnegative(),
    knownOutputTokens: z.number().int().nonnegative(),
    unknownAttemptCount: z.number().int().nonnegative(),
    complete: z.boolean(),
  }).strict(),
  durationMs: z.number().nonnegative(),
  persistence: z.object({
    pendingDraftCount: z.number().int().nonnegative(),
    formalGoalChanged: z.boolean(),
    planCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    deletionObserved: z.boolean(),
  }).strict(),
  checks: MachineChecksSchema,
  machinePassed: z.boolean(),
  crash: z.object({ code: z.string().min(1) }).strict().nullable(),
  heuristicDisclosure: z.literal("关键词、问号和动作分类仅是有限机器启发式，不证明语义质量。"),
}).strict();
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export const HumanReviewSchema = z.object({
  caseId: z.string().min(1),
  goalAccuracy: z.number().int().min(1).max(5),
  actionability: z.number().int().min(1).max(5),
  timeRealism: z.number().int().min(1).max(5),
  verifiability: z.number().int().min(1).max(5),
  constraintRespect: z.number().int().min(1).max(5),
}).strict();
export type HumanReview = z.infer<typeof HumanReviewSchema>;
export const HumanReviewsSchema = z.array(HumanReviewSchema).min(1).superRefine((items, context) => {
  if (new Set(items.map(item => item.caseId)).size !== items.length)
    context.addIssue({ code: "custom", message: "Reviewer case IDs must be unique" });
});
