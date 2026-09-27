import type { Goal, PlanVersion, Task } from "../domain/contracts";

/** Progress display excludes skips; review eligibility deliberately does not. */
export function isReviewEligible(
  goal: Pick<Goal, "id" | "ownerId" | "currentPlanVersionId">,
  plan: Pick<PlanVersion, "id" | "goalId" | "ownerId" | "status"> | null,
  tasks: readonly Pick<Task, "goalId" | "ownerId" | "planVersionId" | "status">[],
): boolean {
  return plan !== null && plan.status === "approved" && plan.id === goal.currentPlanVersionId
    && plan.goalId === goal.id && plan.ownerId === goal.ownerId && tasks.length > 0
    && tasks.every(task => task.status === "done" && task.goalId === goal.id
      && task.ownerId === goal.ownerId && task.planVersionId === plan.id);
}
