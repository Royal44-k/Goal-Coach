import { z } from "zod";
import * as d from "@/core/domain/contracts";
import {
  TaskCreateInputSchema,
  UndoBindingSchema, pairedUndoBinding,
} from "@/lib/public-api-schemas";
export {
  GoalWorkspaceSchema,
  GoalSummarySchema,
  PendingDraftSchema,
  ProgressSchema,
  PublicSettingsSchema,
  StoredPlanSchema,
  type GoalWorkspace,
  type GoalSummary,
  type PendingDraft,
  type Progress,
  type PublicSettings,
  type StoredPlan,
} from "@/lib/public-api-schemas";
import { CheckInCreateInputSchema } from "../repositories/repository-inputs";
import { EvidenceSubmissionSchema } from "@/core/planning/evidence";
import type { ToolResult } from "../agent/tool-contracts";
export const id = z.uuid();
export const version = z.number().int().positive();
export const text = z.string().trim().min(1);
export const blankNote = z.preprocess(value => typeof value === "string" && !value.trim() ? null : value, text.nullable());
export const CreateGoalSchema = z.object({ category: d.GoalCategorySchema, initialMessage: text }).strict();
export const ReplaceContractSchema = z.object({ draftId: id, expectedDraftVersion: version, expectedGoalVersion: version, contract: d.GoalInputSchema, operationId: id }).strict();
export const CreateManualContractDraftSchema = z.object({ expectedGoalVersion: version, contract: d.GoalInputSchema, operationId: id }).strict();
export const SaveContractDraftSchema = z.union([ReplaceContractSchema, CreateManualContractDraftSchema]);
export const ChangeStatusSchema = z.object({ status: z.enum(["paused", "active", "completed"]), expectedVersion: version, operationId: id }).strict();
export const DeleteGoalSchema = z.object({ source: z.literal("ui_confirmation"), confirmationPhrase: text, expectedGoalVersion: version, operationId: id }).strict();
export const DeleteTaskSchema = DeleteGoalSchema.extend({ goalId: id, expectedTaskVersion: version }).strict();
export const ManualPlanDraftSchema = z.object({ goalId: id, expectedPlanVersion: z.object({ id, version }).strict(), expectedGoalVersion: version, changeReason: text, tasks: z.array(TaskCreateInputSchema).min(3).max(8), operationId: id }).strict();
export const RejectReplanSchema = z.object({ goalId: id, draftId: id, expectedDraftVersion: version, expectedGoalVersion: version, operationId: id }).strict();
const taskUpdateCommon = { goalId: id, expectedVersion: version, expectedGoalVersion: version, expectedPlanVersion: z.object({ id, version }).strict(), operationId: id, source: z.literal("ui_explicit"), actualMinutes: d.TaskSchema.shape.actualMinutes.optional() };
const ordinaryTaskUpdate = z.object({ ...taskUpdateCommon, status: z.enum(["todo", "doing", "blocked", "skipped"]).optional() }).strict();
const completionTaskUpdate = z.object({ ...taskUpdateCommon, status: z.literal("done"), evidence: EvidenceSubmissionSchema }).strict();
export const TaskUpdateSchema = z.union([ordinaryTaskUpdate.refine(v => v.status !== undefined || v.actualMinutes !== undefined), completionTaskUpdate]);
export const TaskUpdateBodySchema = z.union([ordinaryTaskUpdate.omit({ goalId: true }).refine(v => v.status !== undefined || v.actualMinutes !== undefined), completionTaskUpdate.omit({ goalId: true })]);
export const CheckInInputSchema = CheckInCreateInputSchema.omit({ goalId: true }).extend({ note: blankNote, expectedGoalVersion: version, operationId: id }).strict();
export const UndoInputSchema = UndoBindingSchema.extend({ operationId: id }).refine(pairedUndoBinding, "Undo ID and goal version must be supplied together");
export const ApproveSchema = z.object({ goalId: id, draftId: id, toolName: z.enum(["save_approved_contract", "save_approved_plan"]), expectedDraftVersion: version, operationId: id }).strict();
export const ClearDataSchema = z.object({ confirmationPhrase: text, expectedSettingId: id, operationId: id }).strict();
export {
  EFFECTIVE_STRATEGIES_MAX_COUNT,
  EFFECTIVE_STRATEGY_MAX_LENGTH,
  EffectiveStrategiesInputSchema,
  ExportBundleSchema,
  PREFERRED_TIME_WINDOW_MAX_LENGTH,
  PreferencesUpdateSchema,
  PreferredTimeWindowInputSchema,
  SettingsUpdateSchema,
  type ExportBundle,
} from "@/lib/public-api-schemas";
export const AgentInputSchema = z.object({ goalId: id, message: text, requestOperationId: id, explicitIntent: z.boolean().default(false) }).strict();
export type ManualPlanDraftInput = z.infer<typeof ManualPlanDraftSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
export type SaveContractDraftInput = z.infer<typeof SaveContractDraftSchema>;
export type ApprovalResult = ToolResult<"save_approved_contract"> | ToolResult<"save_approved_plan">;
export type UndoResult = ToolResult<"undo_last_change">;
