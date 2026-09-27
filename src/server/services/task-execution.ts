import type { Task } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type { EvidenceSubmission } from "@/core/planning/evidence";
import { TaskEvidenceCreateInputSchema } from "../repositories/repository-inputs";
import type { MutationToolContext } from "../agent/tool-executor";
import { conflict, requireGoal } from "./draft-preparation";
import { reconcileTaskSignals } from "./task-signals";
export function applyTaskExecution(ctx: MutationToolContext, input: { goalId: string; taskId: string; expectedTaskVersion: number; status?: Task["status"]; actualMinutes?: number | null }, evidence?: EvidenceSubmission) {
  const tx = ctx.repositories, owner = ctx.ownerId;
  const goal = requireGoal(tx, owner, input.goalId);
  const before = tx.tasks.get(owner, input.taskId);
  if (!before || before.goalId !== goal.id || before.planVersionId !== goal.currentPlanVersionId || before.version !== input.expectedTaskVersion) conflict();
  if (evidence) {
    if (input.status !== "done" || before.status === "done" || evidence.type !== before.evidenceType) throw new AppError("VALIDATION_ERROR", 400, "Evidence does not match a new completion");
    const canonical = evidence.type === "file_metadata" ? { ...evidence, text: null } : { ...evidence, fileName: null, fileSize: null, mimeType: null };
    tx.support.createTaskEvidence(owner, { goalId: goal.id, taskId: before.id, ...canonical });
  } else if (input.status === "done" && before.status !== "done") {
    const exists = tx.support.listEvidenceByTask(owner, before.id).some(e => e.type === before.evidenceType && TaskEvidenceCreateInputSchema.safeParse({ goalId: e.goalId, taskId: e.taskId, type: e.type, text: e.text, fileName: e.fileName, fileSize: e.fileSize, mimeType: e.mimeType }).success);
    if (!exists) throw new AppError("APPROVAL_REQUIRED", 403, "Submit completion evidence through the user interface");
  }
  const task = tx.tasks.update(owner, before.id, before.version, { ...(input.status === undefined ? {} : { status: input.status }), ...(input.actualMinutes === undefined ? {} : { actualMinutes: input.actualMinutes }) });
  ctx.undo.recordTaskPatch({ goalId: goal.id, taskId: task.id, before: { status: before.status, actualMinutes: before.actualMinutes }, after: { status: task.status, actualMinutes: task.actualMinutes } });
  if (input.status === "skipped") tx.support.createAuditEvent(owner, { goalId: goal.id, type: "task_skipped", entityType: "task", entityId: task.id, detail: {} });
  reconcileTaskSignals(tx, owner, goal.id);
  return task;
}
