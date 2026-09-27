import { z } from "zod";
import * as d from "@/core/domain/contracts";
import {
  BlockerAdviceSchema,
  ContractAssumptionSchema,
  GoalContractDraftPayloadSchema,
  DeletedCountsSchema,
  validateContractAssumptions,
  UndoBindingSchema, pairedUndoBinding,
} from "@/lib/public-api-schemas";
import { CheckInCreateInputSchema, TaskPatchSchema } from "../repositories/repository-inputs";
import { PlanRevisionEnvelopeSchema, PlanRevisionPayloadSchema } from "../repositories/revision-contracts";

const uuid = z.string().uuid();
const version = z.number().int().positive();
const text = z.string().trim().min(1);
const optionalNote = z.string().nullable().transform(value => value === null || !value.trim() ? null : value.trim());
const goalArgs = z.object({ goalId: uuid }).strict();
const approvalArgs = goalArgs.extend({ draftId: uuid, expectedDraftVersion: version });
const revisionArgs = goalArgs.extend({ payload: PlanRevisionPayloadSchema });

const assumptions = z.array(ContractAssumptionSchema).describe("Each field may appear at most once. Use an assumption only when contract[field] is non-null; omit it for null fields because the server supplies marked defaults.");
const adviceText = z.object({ minimumNextStep: text, explanation: text }).strict();
export {
  BlockerAdviceSchema,
  ContractAssumptionSchema,
  GoalContractDraftPayloadSchema,
  type BlockerAdvice,
  type ContractAssumption,
  type GoalContractDraftPayload,
} from "@/lib/public-api-schemas";

const contractDraft = d.DraftArtifactSchema.extend({
  kind: z.literal("goal_contract"), payload: GoalContractDraftPayloadSchema,
}).strict();
const planDraft = d.DraftArtifactSchema.extend({
  kind: z.literal("plan"), payload: PlanRevisionPayloadSchema,
}).strict();
const replanDraft = d.DraftArtifactSchema.extend({
  kind: z.literal("replan"), payload: PlanRevisionPayloadSchema,
}).strict();
const taskResult = z.object({ task: d.TaskSchema.strict() }).strict();
const goalResult = z.object({ goal: d.GoalSchema.strict() }).strict();
const plan = d.PlanVersionSchema.extend({ diff: PlanRevisionEnvelopeSchema }).strict();
export { DeletedCountsSchema } from "@/lib/public-api-schemas";

export const toolContracts = {
  get_goal: { args: goalArgs, result: z.object({ goal: d.GoalSchema.strict().nullable() }).strict() },
  list_tasks: { args: goalArgs, result: z.object({ tasks: z.array(d.TaskSchema.strict()) }).strict() },
  get_progress: { args: goalArgs, result: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), percent: z.number().int().min(0).max(100) }).strict() },
  create_goal_contract_draft: {
    args: goalArgs.extend({ expectedGoalVersion: version, contract: d.GoalInputSchema, assumptions }).superRefine(validateContractAssumptions),
    result: z.object({ draft: contractDraft }).strict(),
  },
  create_plan_draft: { args: revisionArgs, result: z.object({ draft: planDraft }).strict() },
  diagnose_blocker: {
    args: goalArgs.extend({ taskId: uuid.nullable(), blockerCategory: d.BlockerCategorySchema, note: optionalNote, advice: adviceText }),
    result: z.object({ advice: BlockerAdviceSchema }).strict(),
  },
  propose_replan: { args: revisionArgs, result: z.object({ draft: replanDraft }).strict() },
  record_check_in: {
    args: CheckInCreateInputSchema.extend({ expectedGoalVersion: version, note: optionalNote }),
    result: z.object({ checkIn: d.CheckInSchema.strict() }).strict(),
  },
  update_task_status: {
    args: goalArgs.extend({ taskId: uuid, expectedTaskVersion: version, ...TaskPatchSchema.shape })
      .refine(value => value.status !== undefined || value.actualMinutes !== undefined, "An execution patch is required"),
    result: taskResult,
  },
  undo_last_change: { args: goalArgs.extend(UndoBindingSchema.shape).refine(pairedUndoBinding, "Undo ID and goal version must be supplied together"), result: d.UndoResultSchema },
  save_approved_contract: { args: approvalArgs, result: goalResult },
  save_approved_plan: { args: approvalArgs, result: z.object({ plan, tasks: z.array(d.TaskSchema.strict()) }).strict() },
  delete_task: {
    args: goalArgs.extend({ taskId: uuid, expectedTaskVersion: version, expectedGoalVersion: version, confirmation: text }),
    result: z.object({ deletedTaskId: uuid, planVersionId: uuid }).strict(),
  },
  delete_goal: {
    args: goalArgs.extend({ expectedGoalVersion: version, confirmation: text }),
    result: z.object({ deletedGoalId: uuid }).strict(),
  },
  clear_all_data: {
    args: z.object({ confirmation: text, expectedSettingId: uuid }).strict(),
    result: z.object({ deletedCounts: DeletedCountsSchema }).strict(),
  },
} as const;

export type ToolName = keyof typeof toolContracts;
export type ToolArgs<N extends ToolName> = z.infer<(typeof toolContracts)[N]["args"]>;
export type ToolResult<N extends ToolName> = z.infer<(typeof toolContracts)[N]["result"]>;
