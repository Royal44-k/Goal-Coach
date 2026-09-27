import type { DraftArtifact, Goal, GoalInput, Task } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import { transition } from "@/core/state-machine/agent-state-machine";
import { diffPlans } from "@/core/planning/plan-diff";
import type { TransactionRepositories } from "../repositories/repository-types";
import { deriveExecutionResets, PlanRevisionEnvelopeSchema, PlanRevisionPayloadSchema, type PlanRevisionPayload, type TaskCreateInput } from "../repositories/revision-contracts";
import { GoalContractDraftPayloadSchema, type ContractAssumption } from "../agent/tool-contracts";
import { canonicalJson, contentHash } from "../security/canonical-json";

export function conflict(): never { throw new AppError("VERSION_CONFLICT", 409, "Review snapshot changed"); }
export function requireGoal(tx: TransactionRepositories, owner: string, goalId: string): Goal {
  const goal = tx.goals.get(owner, goalId);
  if (!goal) throw new AppError("NOT_FOUND", 404, "Goal unavailable");
  return goal;
}
function supersede(tx: TransactionRepositories, owner: string, goalId: string, kind: DraftArtifact["kind"]) {
  for (const draft of tx.support.listPendingDraftArtifacts(owner, goalId))
    if (draft.kind === kind) tx.plans.updateDraftArtifact(owner, draft.id, draft.version, { status: "superseded" });
}
export function persistContractDraft(tx: TransactionRepositories, owner: string, input: { goalId: string; expectedGoalVersion: number; contract: GoalInput; assumptions: ContractAssumption[] }, now: Date) {
  const goal = requireGoal(tx, owner, input.goalId);
  if (goal.version !== input.expectedGoalVersion || goal.currentPlanVersionId !== null || goal.status !== "draft") conflict();
  const preparation = GoalContractDraftPayloadSchema.parse({ schemaVersion: 2, baseGoalVersion: goal.version, contract: input.contract, assumptions: input.assumptions });
  const contract = { ...preparation.contract };
  const assumptions = [...preparation.assumptions];
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const deadline = new Date(`${day}T00:00:00Z`); deadline.setUTCDate(deadline.getUTCDate() + 28);
  const defaults = { deadline: deadline.toISOString().slice(0, 10), weeklyMinutes: 60, constraints: [] as string[], motivation: "先完成这个目标，再根据实际进展调整。" };
  const reasons = { deadline: "暂定为准备草案当日（上海时间）后 28 天，等待你确认。", weeklyMinutes: "暂定每周 60 分钟，等待你确认。", constraints: "暂定尚无补充限制，等待你确认。", motivation: "暂定为先完成目标再调整，等待你确认。" };
  for (const field of ["deadline", "weeklyMinutes", "constraints", "motivation"] as const) {
    if (contract[field] === null) { Object.assign(contract, { [field]: defaults[field] }); assumptions.push({ field, reason: reasons[field] }); }
  }
  const next = tx.goals.update(owner, goal.id, goal.version, { agentState: goal.agentState === "contract_review" ? "contract_review" : transition(goal.agentState, "contract_review") });
  supersede(tx, owner, goal.id, "goal_contract");
  const payload = GoalContractDraftPayloadSchema.parse({ schemaVersion: 2, baseGoalVersion: next.version, contract, assumptions });
  return tx.plans.saveDraftArtifact(owner, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) });
}
export function retainedAssumptions(draft: DraftArtifact, contract: GoalInput): ContractAssumption[] {
  const previous = GoalContractDraftPayloadSchema.parse(draft.payload);
  return previous.assumptions.filter(a => canonicalJson(previous.contract[a.field]) === canonicalJson(contract[a.field]));
}
export function taskDiff(source: Task[], tasks: TaskCreateInput[]) {
  // The planning function compares only structural fields; server execution fields are ignored.
  return diffPlans(source, tasks.map(task => ({ ...task, ownerId: "", goalId: "", planVersionId: "", createdAt: "", updatedAt: "", version: 1, status: "todo", actualMinutes: null })));
}
export function makePlanPayload(goal: Goal, source: Task[], tasks: TaskCreateInput[], milestones: string[], changeReason: string | null, changeSource: "agent" | "user"): PlanRevisionPayload {
  return PlanRevisionPayloadSchema.parse({ schemaVersion: 2, base: { planVersionId: goal.currentPlanVersionId, goalVersion: goal.version }, milestones, changeReason, changeSource, tasks, diff: taskDiff(source, tasks), executionResets: deriveExecutionResets(source, tasks) });
}
export function persistPlanDraft(tx: TransactionRepositories, owner: string, goalId: string, raw: PlanRevisionPayload, source: "agent" | "user", deletion = false) {
  let goal = requireGoal(tx, owner, goalId);
  const value = PlanRevisionPayloadSchema.parse(raw);
  if (goal.version !== value.base.goalVersion || goal.currentPlanVersionId !== value.base.planVersionId) conflict();
  if (!deletion && (value.tasks.length < 3 || value.tasks.length > 8)) throw new AppError("VALIDATION_ERROR", 400, "Plan needs three to eight tasks");
  const current = tx.plans.getCurrent(owner, goalId);
  const tasks = current ? tx.tasks.listByGoal(owner, goalId, current.id) : [];
  const canonical = makePlanPayload(goal, tasks, value.tasks, value.milestones, value.changeReason, source);
  if (canonicalJson(canonical.diff) !== canonicalJson(value.diff) || canonicalJson(canonical.executionResets) !== canonicalJson(value.executionResets)) conflict();
  if (current && Object.values(canonical.diff).every(ids => ids.length === 0) && canonicalJson(value.milestones) === canonicalJson(PlanRevisionEnvelopeSchema.parse(current.diff).revision.payload.milestones))
    throw new AppError("VALIDATION_ERROR", 400, "Unchanged plan proposal");
  if (!deletion) {
    if (goal.agentState === "paused" && goal.status === "paused" && source === "user" && current) {
      goal = tx.goals.update(owner, goal.id, goal.version, { agentState: "paused" });
    } else {
      if (current && goal.agentState !== "replanning") goal = tx.goals.update(owner, goal.id, goal.version, { agentState: transition(goal.agentState, "replanning") });
      goal = tx.goals.update(owner, goal.id, goal.version, { agentState: transition(goal.agentState, "plan_review") });
    }
  }
  const kind = current ? "replan" : "plan";
  supersede(tx, owner, goalId, kind);
  const payload = PlanRevisionPayloadSchema.parse({ ...canonical, base: { ...canonical.base, goalVersion: goal.version } });
  return tx.plans.saveDraftArtifact(owner, { goalId, kind, payload, contentHash: contentHash(payload) });
}
