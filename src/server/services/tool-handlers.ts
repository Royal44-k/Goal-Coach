import { CompleteGoalContractSchema } from "@/core/domain/contracts";
import { assertModelPlanConstraints } from "../agent/model-plan-proposal";
import { shanghaiInstant } from "./workspace-projection";
import { AppError } from "@/core/errors/app-error";
import { calculateProgress } from "@/core/planning/progress";
import { transition } from "@/core/state-machine/agent-state-machine";
import type { ToolHandlers, MutationToolContext } from "../agent/tool-executor";
import { GoalContractDraftPayloadSchema } from "../agent/tool-contracts";
import type { ServerEnv } from "../config/env";
import { PlanRevisionEnvelopeSchema, TaskCreateInputSchema } from "../repositories/revision-contracts";
import { conflict, makePlanPayload, persistContractDraft, persistPlanDraft, requireGoal } from "./draft-preparation";
import { reviewedDraft } from "./approval-reviewers";
import { defaultSettings } from "./settings-service";
import { applyTaskExecution } from "./task-execution";
import { reconcileTaskSignals } from "./task-signals";
import { reconcileReviewState } from "./review-state";

function approvePlan(args: { goalId: string; draftId: string; expectedDraftVersion: number }, ctx: MutationToolContext, restoreState = false) {
  const { goal, draft } = reviewedDraft(args, ctx);
  const tx = ctx.repositories, owner = ctx.ownerId;
  const staged = tx.plans.createDraft(owner, goal.id, { draftArtifactId: draft.id, expectedDraftArtifactVersion: draft.version });
  if (!restoreState) transition(goal.agentState, "active");
  const plan = tx.plans.approve(owner, staged.id, staged.version);
  const activated = requireGoal(tx, owner, goal.id);
  if (restoreState || goal.agentState === "paused") {
    if (goal.agentState === "paused") transition("active", "paused");
    tx.goals.update(owner, goal.id, activated.version, { status: goal.status, agentState: goal.agentState });
  }
  tx.plans.updateDraftArtifact(owner, draft.id, draft.version, { status: "approved" });
  reconcileReviewState(tx, owner, goal.id);
  return { plan: { ...plan, diff: PlanRevisionEnvelopeSchema.parse(plan.diff) }, tasks: tx.tasks.listByGoal(owner, goal.id, plan.id) };
}
export function createToolHandlers(env: ServerEnv, now: () => Date): ToolHandlers {
  return {
    get_goal: async (args, ctx) => ({ goal: await ctx.repositories.goals.get(ctx.ownerId, args.goalId) }),
    list_tasks: async (args, ctx) => { const plan = await ctx.repositories.plans.getCurrent(ctx.ownerId, args.goalId); return { tasks: plan ? await ctx.repositories.tasks.listByGoal(ctx.ownerId, args.goalId, plan.id) : [] }; },
    get_progress: async (args, ctx) => { const plan = await ctx.repositories.plans.getCurrent(ctx.ownerId, args.goalId); return calculateProgress(plan ? await ctx.repositories.tasks.listByGoal(ctx.ownerId, args.goalId, plan.id) : []); },
    diagnose_blocker: args => ({ advice: { taskId: args.taskId, blockerCategory: args.blockerCategory, ...args.advice } }),
    create_goal_contract_draft(args, ctx) {
      if (ctx.source !== "model") {
        const goal = requireGoal(ctx.repositories, ctx.ownerId, args.goalId);
        if (goal.version !== args.expectedGoalVersion || ctx.repositories.support.listPendingDraftArtifacts(ctx.ownerId, goal.id).some(d => d.kind === "goal_contract")) conflict();
        if (goal.status !== "draft" || goal.currentPlanVersionId !== null || (goal.agentState !== "intake" && goal.agentState !== "clarifying"))
          throw new AppError("INVALID_TRANSITION", 409, "Manual bootstrap requires intake without a pending contract");
      }
      const draft = persistContractDraft(ctx.repositories, ctx.ownerId, args, now());
      return { draft: { ...draft, kind: "goal_contract", payload: GoalContractDraftPayloadSchema.parse(draft.payload) } };
    },
    create_plan_draft: (args, ctx) => {
      if (ctx.source === "model") {
        const goal = requireGoal(ctx.repositories, ctx.ownerId, args.goalId);
        const current = ctx.repositories.plans.getCurrent(ctx.ownerId, args.goalId);
        if (goal.version !== args.payload.base.goalVersion || goal.currentPlanVersionId !== args.payload.base.planVersionId
          || (current?.id ?? null) !== args.payload.base.planVersionId) conflict();
        assertModelPlanConstraints(goal, current ? ctx.repositories.tasks.listByGoal(ctx.ownerId, args.goalId, current.id) : [], args.payload.tasks,
          ctx.repositories.support.listCheckInsByGoal(ctx.ownerId, args.goalId), shanghaiInstant(now()));
      }
      return { draft: persistPlanDraft(ctx.repositories, ctx.ownerId, args.goalId, args.payload, ctx.source === "model" ? "agent" : "user") } as ReturnType<ToolHandlers["create_plan_draft"]>;
    },
    propose_replan: (args, ctx) => {
      if (ctx.source === "model") {
        const goal = requireGoal(ctx.repositories, ctx.ownerId, args.goalId);
        const current = ctx.repositories.plans.getCurrent(ctx.ownerId, args.goalId);
        if (goal.version !== args.payload.base.goalVersion || goal.currentPlanVersionId !== args.payload.base.planVersionId
          || (current?.id ?? null) !== args.payload.base.planVersionId) conflict();
        assertModelPlanConstraints(goal, current ? ctx.repositories.tasks.listByGoal(ctx.ownerId, args.goalId, current.id) : [], args.payload.tasks,
          ctx.repositories.support.listCheckInsByGoal(ctx.ownerId, args.goalId), shanghaiInstant(now()));
      }
      return { draft: persistPlanDraft(ctx.repositories, ctx.ownerId, args.goalId, args.payload, ctx.source === "model" ? "agent" : "user") } as ReturnType<ToolHandlers["propose_replan"]>;
    },
    record_check_in(args, ctx) {
      const { expectedGoalVersion, ...input } = args;
      if (requireGoal(ctx.repositories, ctx.ownerId, args.goalId).version !== expectedGoalVersion) conflict();
      const checkIn = ctx.repositories.support.createCheckIn(ctx.ownerId, input);
      reconcileTaskSignals(ctx.repositories, ctx.ownerId, args.goalId);
      return { checkIn };
    },
    update_task_status: (args, ctx) => ({ task: applyTaskExecution(ctx, args) }),
    undo_last_change(args, ctx) { const result = ctx.undo.undoLast(args.goalId, args); reconcileTaskSignals(ctx.repositories, ctx.ownerId, args.goalId); return result; },
    save_approved_contract(args, ctx) {
      const { goal, draft } = reviewedDraft(args, ctx);
      const payload = GoalContractDraftPayloadSchema.parse(draft.payload);
      const contract = CompleteGoalContractSchema.parse(payload.contract);
      const updated = ctx.repositories.goals.update(ctx.ownerId, goal.id, goal.version, { ...contract, agentState: transition(goal.agentState, "planning") });
      ctx.repositories.plans.updateDraftArtifact(ctx.ownerId, draft.id, draft.version, { status: "approved" });
      return { goal: updated };
    },
    save_approved_plan: approvePlan,
    delete_task(args, ctx) {
      const tx = ctx.repositories, owner = ctx.ownerId;
      const goal = requireGoal(tx, owner, args.goalId);
      const current = tx.plans.getCurrent(owner, goal.id);
      if (!current) conflict();
      const tasks = tx.tasks.listByGoal(owner, goal.id, current.id);
      if (tasks.some(t => t.dependencyIds.includes(args.taskId))) throw new AppError("VERSION_CONFLICT", 409, "Task is still a prerequisite");
      const remaining = tasks.filter(t => t.id !== args.taskId).map(t => TaskCreateInputSchema.strip().parse(t));
      const payload = makePlanPayload(goal, tasks, remaining, PlanRevisionEnvelopeSchema.parse(current.diff).revision.payload.milestones, "用户确认删除任务", "user");
      const draft = persistPlanDraft(tx, owner, goal.id, payload, "user", true);
      const result = approvePlan({ goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version }, ctx, true);
      return { deletedTaskId: args.taskId, planVersionId: result.plan.id };
    },
    delete_goal(args, ctx) { ctx.repositories.goals.delete(ctx.ownerId, args.goalId); return { deletedGoalId: args.goalId }; },
    clear_all_data(_args, ctx) {
      const deletedCounts = ctx.repositories.support.clearOwnerData(ctx.ownerId, ctx.operation.id);
      ctx.repositories.support.createAppSetting(ctx.ownerId, defaultSettings(env));
      return { deletedCounts };
    },
  };
}
