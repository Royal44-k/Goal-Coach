import type { GoalWorkspace } from "@/server/services/service-contracts";
import type { EvidenceSubmission } from "@/core/planning/evidence";
import type { PlanRevisionEnvelope } from "@/server/repositories/revision-contracts";
import type { PlanRevisionPayload } from "@/server/repositories/revision-contracts";
import { calendarDayEndInstant } from "@/core/planning/calendar";

type Revision = Pick<PlanRevisionEnvelope["revision"], "taskMap" | "evidenceMap"> & {
  payload: Pick<PlanRevisionEnvelope["revision"]["payload"], "executionResets">;
};
function equal(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function ordered<T extends { id: string }>(values: readonly T[]) { return [...values].sort((a, b) => a.id.localeCompare(b.id)); }
/** Independent exact receipt gate; not a claim to score arbitrary model prose. */
export function capacityRefusalMatches(reply: string, capacity: { estimatedRemainingMinutes: number; proposedUnfinishedMinutes: number }): boolean {
  if (!Object.values(capacity).every(value => Number.isSafeInteger(value) && value >= 0)
    || capacity.proposedUnfinishedMinutes <= capacity.estimatedRemainingMinutes) return false;
  return reply === "这份计划提案未保存：未完成工作的估时超过按当前信息估算的剩余可用时间。"
    + `刚才被拒绝提案校验时：未完成估时${capacity.proposedUnfinishedMinutes}分钟，可用${capacity.estimatedRemainingMinutes}分钟。`
    + "请明确选择调整交付范围或可用时间，并重新核算可行性；如需修改目标期限，须先经过契约审批。不能保证任一选择必然可行，也不会自动修改目标。";
}
/** Separate current-plan path: positive telemetry for every response, never a fallback for unknown tools. */
export function currentCapacityRefusalMatches(reply: string,
  capacity: { estimatedRemainingMinutes: number | null; proposedUnfinishedMinutes: number },
  toolCallCounts: readonly (number | undefined)[]): boolean {
  const { estimatedRemainingMinutes: available, proposedUnfinishedMinutes: unfinished } = capacity;
  if (available === null || !Number.isSafeInteger(available) || available < 0
    || !Number.isSafeInteger(unfinished) || unfinished <= available
    || toolCallCounts.length === 0 || !toolCallCounts.every(count => count === 0)) return false;
  return reply === `本轮尚未生成重规划草案：当前未完成估时${unfinished}分钟，剩余估算可用${available}分钟，按当前估时有${unfinished - available}分钟缺口。`
    + "你希望先调整可用时间，还是通过界面审阅目标范围或期限变更？目标契约不会自动修改，调整后仍需重新核算。";
}
function formalGoal(w: GoalWorkspace) {
  const { title, category, status, desiredOutcome, definitionOfDone, deadline, weeklyMinutes, constraints, motivation,
    currentPlanVersionId } = w.goal;
  return { title, category, status, desiredOutcome, definitionOfDone, deadline, weeklyMinutes, constraints, motivation,
    currentPlanVersionId };
}

export function syntheticEvidence(task: GoalWorkspace["tasks"][number]): EvidenceSubmission {
  if (task.evidenceType === "file_metadata")
    return { type: "file_metadata", fileName: "synthetic-evidence.txt", fileSize: 42, mimeType: "text/plain" };
  return { type: task.evidenceType, text: `合成验收证据：${task.doneCriteria}` };
}

/** Completed historical dates may remain; unfinished/new model work cannot imply a contract extension. */
export function proposedUnfinishedDuesWithinDeadline(before: GoalWorkspace, payload: PlanRevisionPayload): boolean {
  const deadline = before.goal.deadline;
  if (!deadline) return true;
  const completed = new Set(before.tasks.filter(task => task.status === "done").map(task => task.id));
  return payload.tasks.every(task => completed.has(task.id) || task.dueAt === null || task.dueAt <= deadline);
}

/** Independent evaluation check on a saved proposal, using its sealed reset list and workspace feedback. */
export function proposedUnfinishedWithinCapacity(before: GoalWorkspace, payload: Pick<PlanRevisionPayload, "tasks" | "executionResets">, now: Date) {
  const source = new Map(before.tasks.map(task => [task.id, task]));
  const resets = new Set(payload.executionResets.map(reset => reset.taskKey));
  const proposedUnfinishedMinutes = payload.tasks.reduce((sum, task) => {
    const old = source.get(task.id);
    return sum + (!old || (old.status !== "done" && old.status !== "skipped") || resets.has(task.id)
      ? task.estimateMinutes : 0);
  }, 0);
  const { deadline, weeklyMinutes } = before.goal;
  if (deadline === null || weeklyMinutes === null)
    return { withinCapacity: false, estimatedRemainingMinutes: null, proposedUnfinishedMinutes };
  const latest = before.checkIns.findLast(checkIn => checkIn.withdrawnAt === null
    && checkIn.kind === "availability_change" && checkIn.availableWeeklyMinutes !== null);
  const weekly = latest?.availableWeeklyMinutes ?? weeklyMinutes;
  const remainingMs = Math.max(0, calendarDayEndInstant(deadline, 8 * 60) - now.getTime());
  const estimatedRemainingMinutes = Math.floor(weekly * remainingMs / (7 * 24 * 60 * 60 * 1_000));
  return { withinCapacity: proposedUnfinishedMinutes <= estimatedRemainingMinutes,
    estimatedRemainingMinutes, proposedUnfinishedMinutes };
}

/** Conservative aggregate effort policy, not semantic proof of work coverage or true estimates. */
export function proposedRemainingWorkloadPreserved(before: GoalWorkspace, payload: Pick<PlanRevisionPayload, "tasks" | "executionResets">): boolean {
  const original = before.tasks.filter(task => task.status !== "done" && task.status !== "skipped")
    .reduce((total, task) => total + task.estimateMinutes, 0);
  const proposed = payload.tasks.reduce((total, task) => {
    const old = before.tasks.find(item => item.id === task.id);
    const terminalRetained = old && (old.status === "done" || old.status === "skipped")
      && !payload.executionResets.some(reset => reset.taskKey === task.id);
    return total + (terminalRetained ? 0 : task.estimateMinutes);
  }, 0);
  return proposed >= original;
}

/** Independent exact-work content gate; ambiguous repeated text is not semantically matched. */
export function proposedUnchangedWorkEstimatesPreserved(before: GoalWorkspace, payload: PlanRevisionPayload): boolean {
  const previousById = new Map(before.tasks.map(task => [task.id, task]));
  const draftById = new Map(payload.tasks.map(task => [task.id, task]));
  const active = before.tasks.filter(task => task.status !== "done" && task.status !== "skipped");
  for (const previous of active) {
    const draft = draftById.get(previous.id);
    if (draft && draft.action === previous.action && draft.doneCriteria === previous.doneCriteria
      && draft.estimateMinutes < previous.estimateMinutes) return false;
  }
  const key = (task: { action: string; doneCriteria: string }) => JSON.stringify([task.action, task.doneCriteria]);
  const oldGroups = new Map<string, typeof active>();
  for (const previous of active.filter(task => !draftById.has(task.id))) {
    const workKey = key(previous);
    oldGroups.set(workKey, [...(oldGroups.get(workKey) ?? []), previous]);
  }
  const newGroups = new Map<string, typeof payload.tasks>();
  for (const draft of payload.tasks.filter(task => !previousById.has(task.id))) {
    const workKey = key(draft);
    newGroups.set(workKey, [...(newGroups.get(workKey) ?? []), draft]);
  }
  for (const [workKey, oldRows] of oldGroups) {
    const newRows = newGroups.get(workKey);
    if (oldRows.length === 1 && newRows?.length === 1 && newRows[0].estimateMinutes < oldRows[0].estimateMinutes)
      return false;
  }
  return true;
}

/** A pending proposal may change goal state/version, never the current formal plan or recorded work. */
export function pendingReplanPreserved(before: GoalWorkspace, after: GoalWorkspace): boolean {
  return equal(formalGoal(before), formalGoal(after))
    && equal(before.currentPlan, after.currentPlan)
    && equal(ordered(before.tasks), ordered(after.tasks))
    && equal(ordered(before.evidence), ordered(after.evidence));
}

/** Match completed source rows to stored successor rows and copied evidence by sealed revision IDs. */
export function approvedReplanPreserved(before: GoalWorkspace, after: GoalWorkspace, revision: Revision): boolean {
  if (!before.currentPlan || !after.currentPlan || before.currentPlan.id === after.currentPlan.id
    || revision.taskMap.length !== after.tasks.length
    || new Set(revision.taskMap.map(item => item.storedTaskId)).size !== revision.taskMap.length
    || new Set(revision.evidenceMap.map(item => item.sourceEvidenceId)).size !== revision.evidenceMap.length
    || new Set(revision.evidenceMap.map(item => item.copiedEvidenceId)).size !== revision.evidenceMap.length) return false;
  const sourceTasks = new Map(before.tasks.map(task => [task.id, task]));
  const successorTasks = new Map(after.tasks.map(task => [task.id, task]));
  const taskMap = new Map(revision.taskMap.filter(item => item.sourceTaskId).map(item => [item.sourceTaskId!, item]));
  const reset = new Set(revision.payload.executionResets.map(item => item.taskKey));
  const sourceEvidence = before.evidence.filter(item => sourceTasks.get(item.taskId)?.status === "done");
  const copiedEvidence = new Map(after.evidence.map(item => [item.id, item]));
  const evidenceMap = new Map(revision.evidenceMap.map(item => [item.sourceEvidenceId, item.copiedEvidenceId]));
  for (const source of before.tasks.filter(task => task.status === "done")) {
    const mapped = taskMap.get(source.id);
    if (!mapped || reset.has(mapped.draftKey)) return false;
    const successor = successorTasks.get(mapped.storedTaskId);
    if (!successor || successor.status !== "done" || successor.actualMinutes !== source.actualMinutes
      || successor.ownerId !== source.ownerId || successor.goalId !== source.goalId
      || successor.action !== source.action
      || successor.doneCriteria !== source.doneCriteria || successor.evidenceType !== source.evidenceType) return false;
    const mappedDependencies = source.dependencyIds.map(id => taskMap.get(id)?.storedTaskId);
    if (mappedDependencies.some(id => !id)
      || !equal([...mappedDependencies].sort(), [...successor.dependencyIds].sort())) return false;
  }
  if (revision.evidenceMap.length < sourceEvidence.length) return false;
  for (const source of sourceEvidence) {
    const copiedId = evidenceMap.get(source.id);
    const copy = copiedId && copiedEvidence.get(copiedId);
    const successorTaskId = taskMap.get(source.taskId)?.storedTaskId;
    if (!copy || !successorTaskId || copy.taskId !== successorTaskId || copy.goalId !== source.goalId
      || copy.ownerId !== source.ownerId
      || copy.type !== source.type || copy.text !== source.text || copy.fileName !== source.fileName
      || copy.fileSize !== source.fileSize || copy.mimeType !== source.mimeType) return false;
  }
  return true;
}
