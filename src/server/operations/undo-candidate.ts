import { z } from "zod";
import { TaskSchema, TaskStatusSchema } from "@/core/domain/contracts";
import type { TransactionRepositories } from "../repositories/repository-types";

export const TaskExecutionPatchSchema = z.object({ status: TaskStatusSchema, actualMinutes: TaskSchema.shape.actualMinutes }).strict();

/** The newest pending row is authoritative, including when it is no longer eligible. */
export function undoCandidate(tx: TransactionRepositories, owner: string, goalId: string) {
  const latest = tx.support.getLatestPendingUndo(owner, goalId);
  const goal = tx.goals.get(owner, goalId);
  let reason: string | null = null;
  let label = latest?.kind === "check_in" ? "最近一次反馈" : "最近一次任务修改";
  if (!latest) reason = "暂无可以撤销的修改。";
  else if (!goal || !["active", "reviewing", "paused"].includes(goal.agentState)) reason = "当前目标状态下不能撤销，请先处理待批准的计划。";
  else if (latest.kind === "check_in") {
    const checkIn = latest.checkInId ? tx.support.getCheckIn(owner, latest.checkInId) : null;
    if (!checkIn || checkIn.goalId !== goalId || checkIn.withdrawnAt !== null) reason = "最近反馈已发生变化，请刷新后重试。";
    else label = checkIn.kind === "blocker" ? "最近一次阻碍反馈" : "最近一次打卡反馈";
  } else {
    const task = latest.taskId ? tx.tasks.get(owner, latest.taskId) : null;
    const plan = tx.plans.getCurrent(owner, goalId);
    const forward = TaskExecutionPatchSchema.safeParse(latest.forwardPatch);
    const reverse = TaskExecutionPatchSchema.safeParse(latest.reversePatch);
    if (!task || !plan || plan.status !== "approved" || goal.currentPlanVersionId !== plan.id || task.goalId !== goalId || task.planVersionId !== plan.id) reason = "最近修改属于历史计划，不能撤销。";
    else if (!forward.success || !reverse.success || task.status !== forward.data.status || task.actualMinutes !== forward.data.actualMinutes) reason = "最近任务的状态已发生变化，不能撤销。";
    else label = `任务：${task.title}`;
  }
  return { latest, candidate: latest ? { id: latest.id, kind: latest.kind, label } : null, reason, canUndo: latest !== null && reason === null };
}
