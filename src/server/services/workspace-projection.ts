import type { CheckIn } from "@/core/domain/contracts";
import { detectReplanTriggers } from "@/core/planning/adaptation";
import { calculateProgress } from "@/core/planning/progress";
import { remainingPlanningCapacity } from "@/core/planning/remaining-capacity";
import { chooseNextAction } from "@/core/planning/next-action";
import type { TransactionRepositories } from "../repositories/repository-types";
import { PlanRevisionEnvelopeSchema } from "../repositories/revision-contracts";
import { undoCandidate } from "../operations/undo-candidate";
import { requireGoal } from "./draft-preparation";
import { GoalWorkspaceSchema, StoredPlanSchema } from "./service-contracts";
import { savedReflection } from "./saved-reflection";

export function planningProjection(tx: TransactionRepositories, owner: string, goalId: string) {
  const goal = requireGoal(tx, owner, goalId);
  const plan = tx.plans.getCurrent(owner, goalId);
  const tasks = plan ? tx.tasks.listByGoal(owner, goalId, plan.id) : [];
  const history = tx.plans.listVersions(owner, goalId).map(value => StoredPlanSchema.parse(value));
  const checkIns = tx.support.listCheckInsByGoal(owner, goalId);
  const events = tx.support.listAuditEventsByGoal(owner, goalId);
  // Map only retained completion meaning through each approved predecessor chain.
  const current = new Map(tasks.map(t => [t.id, t.id]));
  let cursor = plan;
  while (cursor) {
    const { payload, taskMap } = PlanRevisionEnvelopeSchema.parse(cursor.diff).revision;
    const reset = new Set(payload.executionResets.map(r => r.taskKey));
    for (const m of taskMap) if (m.sourceTaskId && !reset.has(m.draftKey) && current.has(m.storedTaskId)) current.set(m.sourceTaskId, current.get(m.storedTaskId)!);
    cursor = payload.base.planVersionId ? history.find(p => p.id === payload.base.planVersionId) ?? null : null;
  }
  const projectedCheckIns: CheckIn[] = checkIns.filter(c => c.withdrawnAt === null).flatMap(c => c.taskId === null ? [c] : current.has(c.taskId) ? [{ ...c, taskId: current.get(c.taskId)! }] : []);
  const projectedEvents = events.flatMap(e => current.has(e.entityId) ? [{ ...e, entityId: current.get(e.entityId)! }] : []);
  return { goal, plan, tasks, history, checkIns, projectedCheckIns, projectedEvents };
}
export function shanghaiInstant(now: Date) { return new Date(now.getTime() + 8 * 3600_000).toISOString().replace("Z", "+08:00"); }
const reasons = { actual_overrun: "实际耗时明显超出预估。", repeated_skip: "同一任务已多次跳过。", capacity_overload: "剩余任务超过当前时间容量。", availability_reduced: "每周可用时间减少。", unresolved_blocker: "仍有资源或前置任务阻碍。" };
export function planningFacts(p: ReturnType<typeof planningProjection>, now: Date) {
  const capacity = remainingPlanningCapacity(p.goal, p.checkIns, shanghaiInstant(now));
  return {
    latestAvailableWeeklyMinutes: p.checkIns.findLast(c => c.withdrawnAt === null && c.kind === "availability_change" && c.availableWeeklyMinutes !== null)?.availableWeeklyMinutes ?? null,
    estimatedRemainingCapacityMinutes: capacity?.estimatedRemainingMinutes ?? null,
    replanTriggers: detectReplanTriggers({ goal: p.goal, tasks: p.tasks, checkIns: p.projectedCheckIns, taskEvents: p.projectedEvents, now: shanghaiInstant(now) }).map(t => ({ ...t, reason: reasons[t.code] })),
  };
}
export function projectWorkspace(tx: TransactionRepositories, owner: string, goalId: string, now: Date) {
  const p = planningProjection(tx, owner, goalId);
  const summary = tx.conversations.getSummary(owner, goalId);
  const { candidate, canUndo, reason } = undoCandidate(tx, owner, goalId);
  const nextAction = chooseNextAction({ tasks: p.tasks, availableMinutes: 30, now: shanghaiInstant(now) });
  const reviewReflection = savedReflection(tx, owner, goalId);
  return GoalWorkspaceSchema.parse({
    goal: p.goal, currentPlan: p.plan ? { ...p.plan, milestones: PlanRevisionEnvelopeSchema.parse(p.plan.diff).revision.payload.milestones } : null,
    tasks: p.tasks, evidence: p.tasks.flatMap(t => tx.support.listEvidenceByTask(owner, t.id)), checkIns: p.checkIns, effectiveCheckIns: p.projectedCheckIns,
    pendingDrafts: tx.support.listPendingDraftArtifacts(owner, goalId), planHistory: p.history,
    conversation: { summary, recentMessages: tx.conversations.last(owner, goalId, 6) },
    reviewReflection, undoCandidate: candidate, undoUnavailableReason: reason,
    preference: tx.support.getPreferencesByOwner(owner), progress: calculateProgress(p.tasks), canUndo,
    nextAction: nextAction ? { ...nextAction, reasons: ["按30分钟起步窗口推荐", ...nextAction.reasons.filter(reason => reason !== "适合当前可用时间")] } : null,
    replanTriggers: planningFacts(p, now).replanTriggers,
  });
}
