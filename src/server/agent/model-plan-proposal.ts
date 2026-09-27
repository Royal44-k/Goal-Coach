import { z } from "zod";
import type { CheckIn, Goal, Task } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import { remainingPlanningCapacity } from "@/core/planning/remaining-capacity";
import type { Repositories, RepositoryUnitOfWork } from "../repositories/repository-types";
import { deriveExecutionResets, PlanMilestonesSchema, PlanRevisionPayloadSchema, TaskCreateInputSchema, type TaskCreateInput } from "../repositories/revision-contracts";
import { makePlanPayload } from "../services/draft-preparation";
import { shanghaiInstant } from "../services/workspace-projection";

const uuid = z.string().uuid();
const base = z.object({ planVersionId: uuid.nullable(), goalVersion: z.number().int().positive() }).strict();
/** Model-authored structure only; the server owns revision bookkeeping. */
export const modelPlanProposalArgsSchema = z.object({
  goalId: uuid,
  payload: z.object({
    base,
    milestones: PlanMilestonesSchema,
    changeReason: z.string().trim().min(1).nullable(),
    tasks: z.array(TaskCreateInputSchema).min(3).max(8),
  }).strict(),
}).strict().superRefine((proposal, context) => {
  // Reuse the authoritative graph validator without asking the model for bookkeeping.
  const check = PlanRevisionPayloadSchema.safeParse({ schemaVersion: 2, ...proposal.payload,
    changeSource: "agent", diff: { added: [], removed: [], moved: [], changed: [] }, executionResets: [] });
  if (!check.success) context.addIssue({ code: "custom", path: ["payload", "tasks"], message: "Invalid revision task graph" });
});
export type ModelPlanProposalArgs = z.infer<typeof modelPlanProposalArgsSchema>;

export type ModelPlanConstraintRule = "completed_task_reset" | "deadline_exceeded" | "capacity_exceeded" | "unchanged_work_estimate_reduced" | "unfinished_workload_reduced";
export type ModelPlanCapacityFact = { estimatedRemainingMinutes: number; proposedUnfinishedMinutes: number };
export type ModelPlanWorkloadFact = { currentUnfinishedMinutes: number; proposedUnfinishedMinutes: number };
export class ModelPlanConstraintError extends Error {
  constructor(readonly rule: ModelPlanConstraintRule, readonly capacity: ModelPlanCapacityFact | null,
    readonly workload: ModelPlanWorkloadFact | null = null) {
    super(rule); this.name = "ModelPlanConstraintError";
  }
}
function unchangedWorkEstimateReduced(sourceTasks: readonly Task[], proposedTasks: readonly TaskCreateInput[]): boolean {
  const source = new Map(sourceTasks.map(task => [task.id, task]));
  const proposed = new Map(proposedTasks.map(task => [task.id, task]));
  const unfinished = sourceTasks.filter(task => task.status !== "done" && task.status !== "skipped");
  const sameWork = (old: Task, next: TaskCreateInput) => old.action === next.action && old.doneCriteria === next.doneCriteria;
  if (unfinished.some(old => {
    const next = proposed.get(old.id);
    return next && sameWork(old, next) && next.estimateMinutes < old.estimateMinutes;
  })) return true;
  // ID replacements are comparable only when both sides have one exact work-key candidate.
  const removed = unfinished.filter(old => !proposed.has(old.id));
  const added = proposedTasks.filter(next => !source.has(next.id));
  const key = (value: Pick<TaskCreateInput, "action" | "doneCriteria">) => JSON.stringify([value.action, value.doneCriteria]);
  const removedCounts = new Map<string, number>();
  const addedByKey = new Map<string, TaskCreateInput[]>();
  for (const old of removed) removedCounts.set(key(old), (removedCounts.get(key(old)) ?? 0) + 1);
  for (const next of added) addedByKey.set(key(next), [...(addedByKey.get(key(next)) ?? []), next]);
  return removed.some(old => {
    const candidates = addedByKey.get(key(old));
    return removedCounts.get(key(old)) === 1 && candidates?.length === 1
      && candidates[0].estimateMinutes < old.estimateMinutes;
  });
}
/** Model-only commitments; UI-reviewed manual revisions keep their existing reset path. */
export function assertModelPlanConstraints(goal: Goal, sourceTasks: readonly Task[], proposedTasks: readonly TaskCreateInput[],
  checkIns: readonly CheckIn[], now: string): void {
  const proposedIds = new Set(proposedTasks.map(task => task.id));
  const resets = new Set(deriveExecutionResets(sourceTasks, proposedTasks).map(reset => reset.taskKey));
  const source = new Map(sourceTasks.map(task => [task.id, task]));
  const budget = remainingPlanningCapacity(goal, checkIns, now);
  const proposedUnfinishedMinutes = proposedTasks.filter(task => {
    const old = source.get(task.id);
    return !old || (old.status !== "done" && old.status !== "skipped") || resets.has(task.id);
  }).reduce((sum, task) => sum + task.estimateMinutes, 0);
  const currentUnfinishedMinutes = sourceTasks.filter(task => task.status !== "done" && task.status !== "skipped")
    .reduce((sum, task) => sum + task.estimateMinutes, 0);
  const capacity = budget === null ? null : { estimatedRemainingMinutes: budget.estimatedRemainingMinutes,
    proposedUnfinishedMinutes };
  if (sourceTasks.some(task => task.status === "done" && (!proposedIds.has(task.id) || resets.has(task.id))))
    throw new ModelPlanConstraintError("completed_task_reset", capacity);
  const completedIds = new Set(sourceTasks.filter(task => task.status === "done").map(task => task.id));
  if (goal.deadline && proposedTasks.some(task => !completedIds.has(task.id) && task.dueAt !== null && task.dueAt > goal.deadline!))
    throw new ModelPlanConstraintError("deadline_exceeded", capacity);
  if (unchangedWorkEstimateReduced(sourceTasks, proposedTasks))
    throw new ModelPlanConstraintError("unchanged_work_estimate_reduced", capacity);
  if (proposedUnfinishedMinutes < currentUnfinishedMinutes)
    throw new ModelPlanConstraintError("unfinished_workload_reduced", capacity,
      { currentUnfinishedMinutes, proposedUnfinishedMinutes });
  if (capacity && capacity.proposedUnfinishedMinutes > capacity.estimatedRemainingMinutes)
    throw new ModelPlanConstraintError("capacity_exceeded", capacity);
}

export async function materializeModelPlanProposal(input: {
  ownerId: string; turnGoalId: string; proposal: ModelPlanProposalArgs;
  repositories: Repositories & RepositoryUnitOfWork; now: Date;
}) {
  const { ownerId, turnGoalId, proposal, repositories } = input;
  if (proposal.goalId !== turnGoalId) throw new AppError("OWNERSHIP_MISMATCH", 403, "Tool target differs from trusted goal scope");
  return repositories.withTransaction(tx => {
    const goal = tx.goals.get(ownerId, turnGoalId);
    if (!goal) throw new AppError("NOT_FOUND", 404, "Goal unavailable");
    const current = tx.plans.getCurrent(ownerId, turnGoalId);
    if (proposal.payload.base.goalVersion !== goal.version
      || proposal.payload.base.planVersionId !== goal.currentPlanVersionId
      || proposal.payload.base.planVersionId !== (current?.id ?? null))
      throw new AppError("VERSION_CONFLICT", 409, "Review snapshot changed");
    const sourceTasks = current ? tx.tasks.listByGoal(ownerId, turnGoalId, current.id) : [];
    const payload = makePlanPayload(goal, sourceTasks, proposal.payload.tasks,
      proposal.payload.milestones, proposal.payload.changeReason, "agent");
    assertModelPlanConstraints(goal, sourceTasks, payload.tasks, tx.support.listCheckInsByGoal(ownerId, turnGoalId), shanghaiInstant(input.now));
    return { goalId: turnGoalId, payload };
  });
}
