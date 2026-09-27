import { z } from "zod";
import * as d from "@/core/domain/contracts";
import { PlanRevisionPayloadSchema } from "./revision-contracts";
import { validateEvidenceShape } from "@/core/planning/evidence";
import { UserPreferenceCreateInputSchema } from "@/lib/public-api-schemas";
const managed = {
  id: true, ownerId: true, createdAt: true, updatedAt: true, version: true
} as const;
export const GoalCreateInputSchema = d.GoalInputSchema;
export type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;
export const GoalPatchSchema = d.GoalInputSchema.extend({
  status: d.GoalStatusSchema, agentState: d.AgentStateSchema, clarificationCount: d.GoalSchema.shape.clarificationCount
}).partial().strict();
export type GoalPatch = z.infer<typeof GoalPatchSchema>;
export const TaskPatchSchema = z.object(d.TaskSchema.shape).pick({
  status: true, actualMinutes: true
}).partial().strict();
export type TaskPatch = z.infer<typeof TaskPatchSchema>;
export const DraftArtifactCreateInputSchema = d.DraftArtifactSchema.omit({
  ...managed, status: true
}).strict().superRefine((v, ctx) => {
  if ((v.kind === "plan" || v.kind === "replan") && !PlanRevisionPayloadSchema.safeParse(v.payload).success)
    ctx.addIssue({
      code: "custom", message: "Invalid revision payload"
    });
});
export type DraftArtifactCreateInput = z.infer<typeof DraftArtifactCreateInputSchema>;
export const DraftArtifactPatchSchema = z.object({
  status: d.DraftStatusSchema
}).strict();
export const ConversationMessageCreateInputSchema = d.ConversationMessageSchema.pick({
  role: true, content: true
}).strict();
export type ConversationMessageCreateInput = z.infer<typeof ConversationMessageCreateInputSchema>;
export const ConversationSummaryInputSchema = d.ConversationSummarySchema.pick({
  throughMessageId: true, content: true
}).strict();
export type ConversationSummaryInput = z.infer<typeof ConversationSummaryInputSchema>;
// Rebuild the input object so cross-field entity refinements run after server fields are supplied.
export const CheckInCreateInputSchema = z.object(d.CheckInSchema.shape).omit({ ...managed, withdrawnAt: true }).strict();
export type CheckInCreateInput = z.infer<typeof CheckInCreateInputSchema>;
export const TaskEvidenceCreateInputSchema = d.TaskEvidenceSchema.omit(managed).strict().refine(value => value.type === "file_metadata"
  ? value.text === null && validateEvidenceShape(value.type, { fileName: value.fileName, fileSize: value.fileSize, mimeType: value.mimeType })
  : value.fileName === null && value.fileSize === null && value.mimeType === null && validateEvidenceShape(value.type, { text: value.text }));
export type TaskEvidenceCreateInput = z.infer<typeof TaskEvidenceCreateInputSchema>;
export const AgentRunCreateInputSchema = d.AgentRunSchema.omit(managed).strict();
export type AgentRunCreateInput = z.infer<typeof AgentRunCreateInputSchema>;
export const AgentRunPatchSchema = d.AgentRunSchema.pick({
  endState: true, status: true, inputTokenCount: true, outputTokenCount: true, toolCallCount: true, latencyMs: true, errorCode: true
}).partial().strict();
export type AgentRunPatch = z.infer<typeof AgentRunPatchSchema>;
export const ApprovalGrantCreateInputSchema = z.object(d.ApprovalGrantSchema.shape).omit({
  ...managed, usedAt: true
}).strict();
export type ApprovalGrantCreateInput = z.infer<typeof ApprovalGrantCreateInputSchema>;
export const ConsumeApprovalGrantInputSchema = z.object({
  grantId: z.string().uuid(), subjectId: z.string().uuid(), allowedTool: z.string().trim().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/), now: z.iso.datetime({
    offset: true
  }), expectedVersion: z.number().int().positive()
}).strict();
export type ConsumeApprovalGrantInput = z.infer<typeof ConsumeApprovalGrantInputSchema>;
export const OperationCreateInputSchema = d.OperationSchema.omit({
  ...managed, status: true, result: true
}).strict();
export type OperationCreateInput = z.infer<typeof OperationCreateInputSchema>;
export const OperationPatchSchema = d.OperationSchema.pick({
  status: true, result: true
}).partial().strict();
export type OperationPatch = z.infer<typeof OperationPatchSchema>;
export const UndoRecordCreateInputSchema = d.UndoRecordSchema.omit({
  ...managed, undoneAt: true, ordinal: true, conversationFence: true
}).extend({ kind: z.enum(["task_execution", "check_in"]).default("task_execution"), taskId: d.UndoRecordSchema.shape.taskId.default(null), checkInId: d.UndoRecordSchema.shape.checkInId.default(null) }).strict();
export type UndoRecordCreateInput = z.input<typeof UndoRecordCreateInputSchema>;
export const UndoRecordPatchSchema = z.object({
  conversationFence: d.UndoRecordSchema.shape.conversationFence.optional(),
  undoneAt: z.iso.datetime({
    offset: true
  })
}).strict();
export type UndoRecordPatch = z.infer<typeof UndoRecordPatchSchema>;
export { UserPreferenceCreateInputSchema } from "@/lib/public-api-schemas";
export type { UserPreferenceCreateInput } from "@/lib/public-api-schemas";
export const UserPreferencePatchSchema = UserPreferenceCreateInputSchema.partial().strict();
export type UserPreferencePatch = z.infer<typeof UserPreferencePatchSchema>;
export const AuditEventCreateInputSchema = d.AuditEventSchema.omit({
  id: true, ownerId: true, createdAt: true, version: true
}).strict();
export type AuditEventCreateInput = z.infer<typeof AuditEventCreateInputSchema>;
export const AppSettingCreateInputSchema = d.AppSettingSchema.omit(managed).strict();
export type AppSettingCreateInput = z.infer<typeof AppSettingCreateInputSchema>;
export const AppSettingPatchSchema = AppSettingCreateInputSchema.partial().strict();
export type AppSettingPatch = z.infer<typeof AppSettingPatchSchema>;
