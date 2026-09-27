"use client";

import { useState } from "react";
import type { EvidenceType, Task } from "@/core/domain/contracts";
import type { TaskCreateInput } from "@/lib/public-api-schemas";

export type TaskProposal = { changeReason: string; tasks: TaskCreateInput[] };

const evidenceLabels: Record<EvidenceType, string> = {
  text: "文字说明",
  file_metadata: "文件信息",
  check_answer: "检查答案",
  user_declaration: "用户确认",
};

function editableTask(task: Task): TaskCreateInput {
  return {
    id: task.id,
    title: task.title,
    action: task.action,
    doneCriteria: task.doneCriteria,
    evidenceType: task.evidenceType,
    estimateMinutes: task.estimateMinutes,
    dueAt: task.dueAt,
    dependencyIds: [...task.dependencyIds],
  };
}

export function TaskEditor({ tasks, disabled, onCancel, onSubmit }: {
  tasks: Task[];
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (proposal: TaskProposal) => void;
}) {
  const [drafts, setDrafts] = useState<TaskCreateInput[]>(() => tasks.map(editableTask));
  const [reason, setReason] = useState("");
  function update(index: number, patch: Partial<TaskCreateInput>) {
    setDrafts(current => current.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task));
  }
  function addTask() {
    setDrafts(current => [...current, {
      id: crypto.randomUUID(), title: "", action: "", doneCriteria: "", evidenceType: "text",
      estimateMinutes: 30, dueAt: null, dependencyIds: [],
    }]);
  }
  const valid = reason.trim().length > 0 && drafts.length >= 3 && drafts.length <= 8
    && drafts.every(task => task.title.trim() && task.action.trim() && task.doneCriteria.trim() && task.estimateMinutes > 0);
  return (
    <section className="task-editor" role="dialog" aria-modal="true" aria-labelledby="task-editor-title">
      <h2 id="task-editor-title">编辑计划任务</h2>
      <p>保存后会生成完整计划草案；批准前不会替换当前计划。里程碑保持不变。</p>
      <ol>
        {drafts.map((task, index) => {
          const label = task.title.trim() || `新任务 ${index + 1}`;
          return <li key={task.id}>
            <h3>{label}</h3>
            <label>标题：{label}<input value={task.title} disabled={disabled} onChange={event => update(index, { title: event.currentTarget.value })} /></label>
            <label>行动：{label}<textarea value={task.action} disabled={disabled} onChange={event => update(index, { action: event.currentTarget.value })} /></label>
            <label>预计分钟：{label}<input type="number" min="1" step="1" value={task.estimateMinutes} disabled={disabled} onChange={event => update(index, { estimateMinutes: Number(event.currentTarget.value) })} /></label>
            <label>截止日期：{label}<input type="date" value={task.dueAt ?? ""} disabled={disabled} onChange={event => update(index, { dueAt: event.currentTarget.value || null })} /></label>
            <label>完成标准：{label}<textarea value={task.doneCriteria} disabled={disabled} onChange={event => update(index, { doneCriteria: event.currentTarget.value })} /></label>
            <label>证据类型：{label}<select value={task.evidenceType} disabled={disabled} onChange={event => update(index, { evidenceType: event.currentTarget.value as EvidenceType })}>
              {Object.entries(evidenceLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select></label>
            <fieldset><legend>前置任务：{label}</legend>{drafts.filter(candidate => candidate.id !== task.id).map(candidate => (
              <label key={candidate.id}><input type="checkbox" checked={task.dependencyIds.includes(candidate.id)} disabled={disabled} onChange={event => update(index, { dependencyIds: event.currentTarget.checked ? [...task.dependencyIds, candidate.id] : task.dependencyIds.filter(id => id !== candidate.id) })} />{candidate.title || "未命名任务"}</label>
            ))}</fieldset>
          </li>;
        })}
      </ol>
      {drafts.length < 8 ? <button type="button" className="button-secondary" disabled={disabled} onClick={addTask}>添加任务</button> : null}
      <label>修改原因<textarea value={reason} disabled={disabled} onChange={event => setReason(event.currentTarget.value)} /></label>
      <div className="execution-actions">
        <button type="button" disabled={disabled || !valid} onClick={() => onSubmit({ changeReason: reason.trim(), tasks: drafts.map(task => ({ ...task, title: task.title.trim(), action: task.action.trim(), doneCriteria: task.doneCriteria.trim(), dependencyIds: [...task.dependencyIds] })) })}>生成计划草案并审阅</button>
        <button type="button" className="button-secondary" disabled={disabled} onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}
