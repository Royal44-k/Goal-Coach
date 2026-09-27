"use client";

import { useState } from "react";
import type { Task } from "@/core/domain/contracts";

export function DeleteTaskDialog({ task, dependentTasks, disabled, onCancel, onConfirm }: {
  task: Task;
  dependentTasks: Task[];
  disabled: boolean;
  onCancel: () => void;
  onConfirm: (task: Task, confirmationPhrase: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const hasDependencies = dependentTasks.length > 0;
  return (
    <section className="task-dialog task-dialog--danger" role="dialog" aria-modal="true" aria-labelledby="delete-task-title">
      <h2 id="delete-task-title">删除任务：{task.title}</h2>
      <p>任务会从当前计划中移除，历史版本仍会保留。</p>
      {hasDependencies ? <p role="alert">{dependentTasks.map(item => item.title).join("、")} 仍依赖此任务。请先在计划编辑中调整依赖并完成审阅，再删除任务。</p> : null}
      <label>输入任务标题“{task.title}”确认删除
        <input value={confirmation} disabled={disabled || hasDependencies} onChange={event => setConfirmation(event.currentTarget.value)} />
      </label>
      <div className="execution-actions">
        <button type="button" className="button-danger" disabled={disabled || hasDependencies || confirmation !== task.title} onClick={() => onConfirm(task, confirmation)}>确认删除任务</button>
        <button type="button" className="button-secondary" disabled={disabled} onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}
