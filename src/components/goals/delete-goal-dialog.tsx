"use client";

import { useState } from "react";

export function DeleteGoalDialog({ title, version, disabled, onCancel, onConfirm }: {
  title: string;
  version: number;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: (confirmationPhrase: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  return (
    <section className="task-dialog task-dialog--danger" role="dialog" aria-modal="true" aria-labelledby="delete-goal-title">
      <h2 id="delete-goal-title">删除目标：{title}</h2>
      <p>目标及其任务、记录、对话和历史计划会被永久删除。</p>
      <label>输入目标标题确认删除<input aria-label="输入目标标题确认删除" value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.currentTarget.value)} /></label>
      <div className="execution-actions"><button type="button" className="button-danger" disabled={disabled || confirmation !== title} onClick={() => onConfirm(confirmation)}>确认删除目标（目标 {version}）</button><button type="button" className="button-secondary" disabled={disabled} onClick={onCancel}>取消</button></div>
    </section>
  );
}
