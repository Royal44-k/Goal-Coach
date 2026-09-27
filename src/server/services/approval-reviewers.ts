import { CompleteGoalContractSchema } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type { ApprovalReviewers, MutationToolContext } from "../agent/tool-executor";
import { GoalContractDraftPayloadSchema } from "../agent/tool-contracts";
import { PlanRevisionPayloadSchema } from "../repositories/revision-contracts";
import { contentHash } from "../security/canonical-json";
import { conflict, requireGoal } from "./draft-preparation";
export const CLEAR_PHRASE = "清除我的全部本地数据";
export function reviewedDraft(args: { goalId: string; draftId: string; expectedDraftVersion: number }, ctx: MutationToolContext) {
  const goal = requireGoal(ctx.repositories, ctx.ownerId, args.goalId);
  const draft = ctx.repositories.plans.getDraftArtifact(ctx.ownerId, args.draftId);
  if (!draft || draft.goalId !== goal.id || draft.status !== "pending" || draft.version !== args.expectedDraftVersion || contentHash(draft.payload) !== draft.contentHash) conflict();
  return { goal, draft };
}
export const approvalReviewers: ApprovalReviewers = {
  save_approved_contract(args, ctx) {
    const { goal, draft } = reviewedDraft(args, ctx);
    if (draft.kind !== "goal_contract") conflict();
    const payload = GoalContractDraftPayloadSchema.parse(draft.payload);
    if (payload.baseGoalVersion !== goal.version || goal.currentPlanVersionId !== null || goal.agentState !== "contract_review") conflict();
    CompleteGoalContractSchema.parse(payload.contract);
    return { payload };
  },
  save_approved_plan(args, ctx) {
    const { goal, draft } = reviewedDraft(args, ctx);
    if (draft.kind !== "plan" && draft.kind !== "replan") conflict();
    const payload = PlanRevisionPayloadSchema.parse(draft.payload);
    if (payload.base.goalVersion !== goal.version || payload.base.planVersionId !== goal.currentPlanVersionId || (draft.kind === "plan") !== (goal.currentPlanVersionId === null)) conflict();
    if (goal.agentState === "paused" && (goal.status !== "paused" || draft.kind !== "replan" || payload.changeSource !== "user" || !goal.currentPlanVersionId)) conflict();
    return { payload };
  },
  delete_task(args, ctx) {
    const goal = requireGoal(ctx.repositories, ctx.ownerId, args.goalId);
    const task = ctx.repositories.tasks.get(ctx.ownerId, args.taskId);
    if (!task || task.goalId !== goal.id || task.planVersionId !== goal.currentPlanVersionId || task.version !== args.expectedTaskVersion || goal.version !== args.expectedGoalVersion) conflict();
    if (args.confirmation !== task.title) throw new AppError("APPROVAL_REQUIRED", 403, "Task title confirmation required");
    return { payload: args };
  },
  delete_goal(args, ctx) {
    const goal = requireGoal(ctx.repositories, ctx.ownerId, args.goalId);
    if (goal.version !== args.expectedGoalVersion) conflict();
    if (args.confirmation !== goal.title) throw new AppError("APPROVAL_REQUIRED", 403, "Goal title confirmation required");
    return { payload: args };
  },
  clear_all_data(args, ctx) {
    if (args.confirmation !== CLEAR_PHRASE) throw new AppError("APPROVAL_REQUIRED", 403, "Clear confirmation required");
    if (ctx.repositories.support.getSettingsByOwner(ctx.ownerId)?.id !== args.expectedSettingId) conflict();
    return { payload: args };
  },
};
