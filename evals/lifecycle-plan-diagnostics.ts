import type { ModelToolCall } from "@/server/agent/model-contracts";
import { modelPlanProposalArgsSchema } from "@/server/agent/model-plan-proposal";
import { canonicalJson } from "@/server/security/canonical-json";
import { makePlanPayload } from "@/server/services/draft-preparation";
import type { GoalWorkspace } from "@/server/services/service-contracts";
import { diagnoseToolArguments } from "./tool-diagnostics";

type PlanTool = "create_plan_draft" | "propose_replan";
type Status = "invalid_json" | "invalid_arguments" | "workspace_unavailable" | "valid" | "analysis_unavailable";
export type LifecyclePlanDiagnostic = {
  toolName: PlanTool;
  status: Status;
  taskCount: number | null;
  withinTaskRange: boolean | null;
  goalIdMatches: boolean | null;
  baseGoalVersionMatches: boolean | null;
  basePlanVersionMatches: boolean | null;
  canonicalDiffDerived: boolean | null;
  canonicalExecutionResetsDerived: boolean | null;
  hasPlanChange: boolean | null;
  issues: ReturnType<typeof diagnoseToolArguments>["issues"];
};
const empty = (toolName: PlanTool, status: Status, issues: LifecyclePlanDiagnostic["issues"] = []): LifecyclePlanDiagnostic => ({
  toolName, status, taskCount: null, withinTaskRange: null, goalIdMatches: null,
  baseGoalVersionMatches: null, basePlanVersionMatches: null, canonicalDiffDerived: null,
  canonicalExecutionResetsDerived: null, hasPlanChange: null, issues,
});

/** Read-only proposal analysis; never returns argument values, task text, or identifiers. */
export function diagnoseLifecyclePlanCall(call: ModelToolCall, workspace: GoalWorkspace | null): LifecyclePlanDiagnostic | null {
  if (call.name !== "create_plan_draft" && call.name !== "propose_replan") return null;
  const toolName = call.name;
  let raw: unknown;
  try { raw = JSON.parse(call.argumentsJson); }
  catch { return empty(toolName, "invalid_json"); }
  const parsed = modelPlanProposalArgsSchema.safeParse(raw);
  if (!parsed.success) return empty(toolName, "invalid_arguments", diagnoseToolArguments(call).issues);
  const { goalId, payload } = parsed.data;
  if (!workspace) return { ...empty(toolName, "workspace_unavailable"), taskCount: payload.tasks.length,
    withinTaskRange: payload.tasks.length >= 3 && payload.tasks.length <= 8 };
  try {
    const canonical = makePlanPayload(workspace.goal, workspace.tasks, payload.tasks,
      payload.milestones, payload.changeReason, "agent");
    const structuralChange = Object.values(canonical.diff).some(ids => ids.length > 0);
    const milestoneChange = workspace.currentPlan !== null
      && canonicalJson(payload.milestones) !== canonicalJson(workspace.currentPlan.milestones);
    return {
      ...empty(toolName, "valid"),
      taskCount: payload.tasks.length, withinTaskRange: payload.tasks.length >= 3 && payload.tasks.length <= 8,
      goalIdMatches: goalId === workspace.goal.id,
      baseGoalVersionMatches: payload.base.goalVersion === workspace.goal.version,
      basePlanVersionMatches: payload.base.planVersionId === workspace.goal.currentPlanVersionId
        && payload.base.planVersionId === (workspace.currentPlan?.id ?? null),
      canonicalDiffDerived: true,
      canonicalExecutionResetsDerived: true,
      hasPlanChange: workspace.currentPlan === null || structuralChange || milestoneChange,
    };
  } catch { return { ...empty(toolName, "analysis_unavailable"), taskCount: payload.tasks.length,
    withinTaskRange: payload.tasks.length >= 3 && payload.tasks.length <= 8 }; }
}
