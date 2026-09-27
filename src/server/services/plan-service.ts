import { AppError } from "@/core/errors/app-error";
import { transition } from "@/core/state-machine/agent-state-machine";
import type { OperationService } from "../operations/operation-service";
import { PlanRevisionEnvelopeSchema, PlanRevisionPayloadSchema } from "../repositories/revision-contracts";
import { contentHash } from "../security/canonical-json";
import { ManualPlanDraftSchema, RejectReplanSchema } from "./service-contracts";
import { conflict, makePlanPayload, persistPlanDraft, requireGoal } from "./draft-preparation";
import { reconcileReviewState } from "./review-state";
export class PlanService {
  constructor(private readonly operations: OperationService) {}
  createManualDraft(owner: string, raw: unknown) {
    const input = ManualPlanDraftSchema.parse(raw);
    return this.operations.executeOnce({ ownerId: owner, operationId: input.operationId, toolName: "create_manual_plan_draft", scope: { kind: "goal", goalId: input.goalId }, parameters: input, execute: ({ repositories: tx }) => {
      const goal = requireGoal(tx, owner, input.goalId);
      if (!((goal.status === "active" && goal.agentState === "active") || (goal.status === "paused" && goal.agentState === "paused"))) throw new AppError("INVALID_TRANSITION", 409, "Manual proposals need active or paused goal");
      const plan = tx.plans.getCurrent(owner, goal.id);
      if (!plan || plan.id !== input.expectedPlanVersion.id || plan.version !== input.expectedPlanVersion.version || goal.version !== input.expectedGoalVersion) conflict();
      const tasks = tx.tasks.listByGoal(owner, goal.id, plan.id);
      const payload = makePlanPayload(goal, tasks, input.tasks, PlanRevisionEnvelopeSchema.parse(plan.diff).revision.payload.milestones, input.changeReason, "user");
      const draft = persistPlanDraft(tx, owner, goal.id, payload, "user");
      tx.support.createAuditEvent(owner, { goalId: goal.id, type: "manual_plan_draft_saved", entityType: "draft", entityId: draft.id, detail: {} });
      return draft;
    } });
  }
  rejectReplan(owner: string, raw: unknown) {
    const input = RejectReplanSchema.parse(raw);
    return this.operations.executeOnce({ ownerId: owner, operationId: input.operationId, toolName: "reject_replan", scope: { kind: "goal", goalId: input.goalId }, parameters: input, execute: ({ repositories: tx }) => {
      let goal = requireGoal(tx, owner, input.goalId);
      const draft = tx.plans.getDraftArtifact(owner, input.draftId);
      if (!draft || draft.goalId !== goal.id || draft.kind !== "replan" || draft.status !== "pending" || draft.version !== input.expectedDraftVersion || goal.version !== input.expectedGoalVersion || contentHash(draft.payload) !== draft.contentHash) conflict();
      const payload = PlanRevisionPayloadSchema.parse(draft.payload);
      if (payload.base.goalVersion === goal.version && payload.base.planVersionId === goal.currentPlanVersionId) {
        if (goal.agentState === "plan_review" && goal.status === "active") goal = tx.goals.update(owner, goal.id, goal.version, { agentState: transition("plan_review", "active") });
        else if (goal.agentState === "paused" && goal.status === "paused") goal = tx.goals.update(owner, goal.id, goal.version, { agentState: "paused" });
        goal = reconcileReviewState(tx, owner, goal.id);
      }
      tx.plans.updateDraftArtifact(owner, draft.id, draft.version, { status: "rejected" });
      tx.support.createAuditEvent(owner, { goalId: goal.id, type: "replan_rejected", entityType: "draft", entityId: draft.id, detail: {} });
      return { draftId: draft.id, status: "rejected" as const, goal };
    } });
  }
}
