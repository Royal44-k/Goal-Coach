"use client";

import type { Task, TaskEvidence, TaskStatus } from "@/core/domain/contracts";

const statusLabels: Record<TaskStatus, string> = {
  todo: "待开始",
  doing: "进行中",
  blocked: "已阻塞",
  done: "已完成",
  skipped: "已跳过",
};

function evidenceText(evidence: TaskEvidence): string {
  return evidence.type === "file_metadata"
    ? `${evidence.fileName} · ${evidence.fileSize ?? 0} 字节 · ${evidence.mimeType}`
    : evidence.text ?? "";
}

export function TaskBoard({
  tasks,
  evidence,
  disabled,
  onStatusChange,
  onEdit,
  onComplete,
  onDelete,
  onMinutesChange,
  onEditPlan,
  canExecute = true,
  canEdit = true,
  canDelete = true,
}: {
  tasks: Task[];
  evidence: TaskEvidence[];
  disabled: boolean;
  onStatusChange: (taskId: string, expectedVersion: number, status: Exclude<TaskStatus, "done">) => void;
  onEdit: (task: Task) => void;
  onComplete: (task: Task) => void;
  onDelete: (task: Task) => void;
  onMinutesChange?: (taskId: string, expectedVersion: number, actualMinutes: number | null) => void;
  onEditPlan?: () => void;
  canExecute?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
}) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  return (
    <section className="task-board" aria-labelledby="task-board-title">
      <div className="task-board__heading"><div><p className="section-kicker">当前计划</p><h2 id="task-board-title">任务</h2></div>{onEditPlan ? <button type="button" className="button-secondary" disabled={disabled} onClick={onEditPlan}>编辑计划任务</button> : null}</div>
      {tasks.length ? <ol className="current-task-list task-board__list">
        {tasks.map(task => {
          const dependenciesDone = task.dependencyIds.every(id => byId.get(id)?.status === "done");
          const taskEvidence = evidence.filter(item => item.taskId === task.id);
          return (
            <li key={task.id} className="task-board__item">
              <div className="task-board__title"><h3>{task.title}</h3><span>{statusLabels[task.status]}</span></div>
              <p>{task.action}</p>
              <dl>
                <div><dt>预计</dt><dd>{task.estimateMinutes} 分钟</dd></div>
                <div><dt>实际</dt><dd>{task.actualMinutes === null ? "未记录" : `${task.actualMinutes} 分钟`}</dd></div>
                <div><dt>截止</dt><dd>{task.dueAt ?? "未设置"}</dd></div>
                <div><dt>完成标准</dt><dd>{task.doneCriteria}</dd></div>
              </dl>
              {taskEvidence.length ? <section className="task-evidence-history" aria-label={`${task.title}的证据历史`}>
                <h4>{task.status === "done" ? "完成证据" : "历史证据（不表示当前已完成）"}</h4>
                <ul>{taskEvidence.map(item => <li key={item.id}>{evidenceText(item)}</li>)}</ul>
              </section> : null}
              {onMinutesChange ? <label>实际用时（分钟）
                <input key={`${task.id}:${task.version}:actual-minutes`} type="number" min="1" step="1" defaultValue={task.actualMinutes ?? ""} disabled={disabled || !canExecute} onBlur={event => {
                  const value = event.currentTarget.value;
                  const minutes = value === "" ? null : Number(value);
                  if (minutes !== task.actualMinutes && (minutes === null || (Number.isInteger(minutes) && minutes > 0))) onMinutesChange(task.id, task.version, minutes);
                }} />
              </label> : null}
              <div className="task-board__actions">
                {task.status !== "done" ? <button type="button" disabled={disabled || !canExecute || !dependenciesDone || task.status === "blocked"} onClick={() => onStatusChange(task.id, task.version, "doing")}>开始：{task.title}</button> : null}
                {task.status !== "done" ? <button type="button" className="button-secondary" disabled={disabled || !canExecute || !dependenciesDone} onClick={() => onComplete(task)}>完成：{task.title}</button> : null}
                <button type="button" className="button-secondary" disabled={disabled || !canEdit} onClick={() => onEdit(task)}>编辑：{task.title}</button>
                <button type="button" className="button-danger" disabled={disabled || !canDelete} onClick={() => onDelete(task)}>删除：{task.title}</button>
              </div>
            </li>
          );
        })}
      </ol> : <p>当前计划没有任务。</p>}
    </section>
  );
}
