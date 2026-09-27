import type { Repositories, RepositoryUnitOfWork } from "../repositories/repository-types";
import { GoalContractDraftPayloadSchema } from "../agent/tool-contracts";
import type { ToolExecutor } from "../agent/tool-executor";
import type { OperationService } from "../operations/operation-service";
import { calculateProgress } from "@/core/planning/progress";
import { transition } from "@/core/state-machine/agent-state-machine";
import { ChangeStatusSchema, CreateGoalSchema, DeleteGoalSchema, GoalSummarySchema, ReplaceContractSchema, SaveContractDraftSchema, id } from "./service-contracts";
import { conflict, persistContractDraft, requireGoal, retainedAssumptions } from "./draft-preparation";
import { projectWorkspace } from "./workspace-projection";
import { contentHash } from "../security/canonical-json";
import { AppError } from "@/core/errors/app-error";
import { isReviewEligible } from "@/core/planning/review-eligibility";
import { savedReflection } from "./saved-reflection";
import { reconcileReviewState } from "./review-state";
export class GoalService {
  constructor(private readonly r: Repositories & RepositoryUnitOfWork, private readonly operations: OperationService, private readonly tools: ToolExecutor, private readonly now: () => Date) {}
  async list(owner: string) {
    return this.r.withTransaction(tx => tx.goals.list(owner).map(goal => {
      const tasks = goal.currentPlanVersionId ? tx.tasks.listByGoal(owner, goal.id, goal.currentPlanVersionId) : [];
      return GoalSummarySchema.parse({ id: goal.id, title: goal.title, category: goal.category, status: goal.status, agentState: goal.agentState, updatedAt: goal.updatedAt, progress: calculateProgress(tasks) });
    }));
  }
  async create(owner: string, raw: unknown) {
    const input = CreateGoalSchema.parse(raw);
    const goal = await this.r.goals.create(owner, { title: [...input.initialMessage].slice(0, 80).join(""), category: input.category, desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null });
    return { goal, state: "intake" as const };
  }
  getWorkspace(owner: string, goalId: string) { id.parse(goalId); return this.r.withTransaction(tx => projectWorkspace(tx, owner, goalId, this.now())); }
  async saveContractDraft(owner: string, goalId: string, raw: unknown) {
    id.parse(goalId); const input = SaveContractDraftSchema.parse(raw);
    if ("draftId" in input) return this.replaceContractDraft(owner, goalId, input);
    const { operationId, ...values } = input;
    return (await this.tools.execute({ toolName: "create_goal_contract_draft", args: { goalId, ...values, assumptions: [] }, context: { ownerId: owner, goalId, operationId, source: "ui_explicit" } })).draft;
  }
  replaceContractDraft(owner: string, goalId: string, raw: unknown) {
    id.parse(goalId); const input = ReplaceContractSchema.parse(raw);
    return this.operations.executeOnce({ ownerId: owner, operationId: input.operationId, toolName: "replace_contract_draft", scope: { kind: "goal", goalId }, parameters: { goalId, ...input }, execute: ({ repositories: tx }) => {
      const goal = requireGoal(tx, owner, goalId);
      const draft = tx.plans.getDraftArtifact(owner, input.draftId);
      if (!draft || draft.goalId !== goalId || draft.kind !== "goal_contract" || draft.status !== "pending" || draft.version !== input.expectedDraftVersion || goal.version !== input.expectedGoalVersion || contentHash(draft.payload) !== draft.contentHash) conflict();
      const payload = GoalContractDraftPayloadSchema.parse(draft.payload);
      if (payload.baseGoalVersion !== goal.version || goal.agentState !== "contract_review") conflict();
      const next = persistContractDraft(tx, owner, { goalId, expectedGoalVersion: goal.version, contract: input.contract, assumptions: retainedAssumptions(draft, input.contract) }, this.now());
      tx.support.createAuditEvent(owner, { goalId, type: "contract_draft_replaced", entityType: "draft", entityId: next.id, detail: {} });
      return next;
    } });
  }
  changeStatus(owner: string, goalId: string, raw: unknown) {
    id.parse(goalId); const input = ChangeStatusSchema.parse(raw);
    return this.operations.executeOnce({ ownerId: owner, operationId: input.operationId, toolName: "change_goal_status", scope: { kind: "goal", goalId }, parameters: { goalId, ...input }, execute: ({ repositories: tx }) => {
      let goal = requireGoal(tx, owner, goalId);
      if (goal.version !== input.expectedVersion) conflict();
      if (input.status === "completed") {
        if (goal.agentState !== "reviewing" || goal.status !== "active" || !goal.currentPlanVersionId) throw new AppError("INVALID_TRANSITION", 409, "Goal is not ready for completion");
        const plan = tx.plans.getCurrent(owner, goalId);
        const tasks = plan ? tx.tasks.listByGoal(owner, goalId, plan.id) : [];
        if (!isReviewEligible(goal, plan, tasks)) throw new AppError("INVALID_TRANSITION", 409, "Execution is incomplete");
        if (!savedReflection(tx, owner, goalId)) throw new AppError("INVALID_TRANSITION", 409, "A saved reflection is required");
      } else if ((input.status === "paused" && goal.status !== "active") || (input.status === "active" && goal.status !== "paused")) throw new AppError("INVALID_TRANSITION", 409, "Invalid lifecycle request");
      goal = tx.goals.update(owner, goalId, goal.version, { status: input.status, agentState: transition(goal.agentState, input.status) });
      goal = reconcileReviewState(tx, owner, goalId);
      tx.support.createAuditEvent(owner, { goalId, type: "goal_status_changed", entityType: "goal", entityId: goalId, detail: { status: input.status } });
      return goal;
    } });
  }
  async remove(owner: string, goalId: string, raw: unknown): Promise<void> {
    id.parse(goalId); const { operationId, source, confirmationPhrase, expectedGoalVersion } = DeleteGoalSchema.parse(raw);
    await this.tools.execute({ toolName: "delete_goal", args: { goalId, expectedGoalVersion, confirmation: confirmationPhrase }, context: { ownerId: owner, goalId, source, operationId } });
  }
}
