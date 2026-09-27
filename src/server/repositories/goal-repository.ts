import type { GoalRepository, SyncRepository } from "./repository-types";
import { GoalCreateInputSchema, GoalPatchSchema } from "./repository-inputs";
import type { RepositoryContext } from "./repository-internals";
import { deleteGoalData } from "./support-data";
export function goalOperations(ctx: RepositoryContext): SyncRepository<GoalRepository> {
  return {
    create(owner, input) {
      return ctx.stores.goals.create(owner, {
        ...GoalCreateInputSchema.parse(input), status: "draft", agentState: "intake", clarificationCount: 0, currentPlanVersionId: null
      });
    },
    get: (owner, id) => ctx.stores.goals.get(owner, id),
    list: owner => ctx.stores.goals.list(owner),
    update: (owner, id, version, patch) => ctx.stores.goals.update(owner, id, version, GoalPatchSchema.parse(patch)),
    delete(owner, id) {
      deleteGoalData(ctx, owner, id);
    },
  };
}
