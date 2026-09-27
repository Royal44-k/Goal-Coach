import type { Goal } from "@/core/domain/contracts";
import type { TransactionRepositories } from "../repositories/repository-types";

export type GoalCheckpoint = Pick<Goal, "id" | "version" | "agentState" | "status" | "currentPlanVersionId">;
export function goalCheckpoint(goal: Goal | null): GoalCheckpoint | null {
  return goal === null ? null : Object.freeze({ id: goal.id, version: goal.version, agentState: goal.agentState, status: goal.status, currentPlanVersionId: goal.currentPlanVersionId });
}

/** Records only successful facade writes. Caller publishes only after outer commit.
 * Delegation retains repository savepoints and expiry; no raw store is exposed. */
export function observeDomainWrites(source: TransactionRepositories): {
  repositories: TransactionRepositories;
  hasDomainWrite(): boolean;
} {
  let written = false;
  function record<A extends unknown[], R>(method: (...args: A) => R): (...args: A) => R {
    return (...args) => { const result = method(...args); written = true; return result; };
  }
  return {
    hasDomainWrite: () => written,
    repositories: {
      ...source,
      goals: {
        ...source.goals,
        create: record(source.goals.create), update: record(source.goals.update),
        delete: (owner, id) => {
          const existed = source.goals.get(owner, id) !== null;
          source.goals.delete(owner, id);
          if (existed) written = true;
        },
      },
      tasks: { ...source.tasks, createMany: record(source.tasks.createMany), update: record(source.tasks.update), delete: record(source.tasks.delete) },
      plans: { ...source.plans, createDraft: record(source.plans.createDraft), approve: record(source.plans.approve) },
      support: {
        ...source.support,
        createCheckIn: record(source.support.createCheckIn), createTaskEvidence: record(source.support.createTaskEvidence),
        withdrawCheckIn: record(source.support.withdrawCheckIn),
        clearOwnerData: (owner, retainedId) => {
          const counts = source.support.clearOwnerData(owner, retainedId);
          if (["goals", "tasks", "planVersions", "checkIns", "evidence"].some(key => counts[key] > 0)) written = true;
          return counts;
        },
      },
    },
  };
}
