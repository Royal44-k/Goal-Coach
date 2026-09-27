import { isReviewEligible } from "@/core/planning/review-eligibility";
import { transition } from "@/core/state-machine/agent-state-machine";
import type { TransactionRepositories } from "../repositories/repository-types";
import { requireGoal } from "./draft-preparation";

/** Only mutation owners call this inside their existing transaction. Reads never repair state. */
export function reconcileReviewState(tx: TransactionRepositories, owner: string, goalId: string) {
  const goal = requireGoal(tx, owner, goalId);
  if (goal.status !== "active" || (goal.agentState !== "active" && goal.agentState !== "reviewing")) return goal;
  const plan = tx.plans.getCurrent(owner, goalId);
  const tasks = plan ? tx.tasks.listByGoal(owner, goalId, plan.id) : [];
  const next = isReviewEligible(goal, plan, tasks) ? "reviewing" : "active";
  return goal.agentState === next ? goal
    : tx.goals.update(owner, goalId, goal.version, { agentState: transition(goal.agentState, next) });
}
