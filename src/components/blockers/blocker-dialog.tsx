"use client";

import { useState } from "react";
import type { BlockerCategory, Task } from "@/core/domain/contracts";

const categories: ReadonlyArray<{ value: BlockerCategory; label: string }> = [
  { value: "cannot_start", label: "不知道如何开始" },
  { value: "task_too_large", label: "任务太大，不知道怎么开始" },
  { value: "insufficient_time", label: "时间不足" },
  { value: "missing_resource", label: "缺少资源或信息" },
  { value: "fear_of_error", label: "担心做错" },
  { value: "prerequisite_incomplete", label: "前置条件尚未完成" },
];

export type BlockerReport = {
  taskId: string | null;
  blockerCategory: BlockerCategory;
  note: string | null;
  minutesSpent: null;
  availableWeeklyMinutes: null;
};

export function BlockerDialog({
  task,
  disabled,
  onCancel,
  onSubmit,
}: {
  task: Task | null;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (report: BlockerReport) => void;
}) {
  const [category, setCategory] = useState<BlockerCategory | null>(null);
  const [note, setNote] = useState("");

  return (
    <section className="task-dialog blocker-dialog" role="dialog" aria-modal="true" aria-labelledby="blocker-dialog-title">
      <p className="section-kicker">记录真实阻碍</p>
      <h2 id="blocker-dialog-title">哪里卡住了？</h2>
      <p>{task ? `这次记录关联任务：${task.title}` : "这次记录关联整个目标，不指定任务。"}</p>
      <fieldset>
        <legend>选择最接近的情况</legend>
        <div className="blocker-dialog__options">
          {categories.map(option => (
            <label key={option.value}>
              <input
                type="radio"
                name="blocker-category"
                value={option.value}
                checked={category === option.value}
                disabled={disabled}
                onChange={() => setCategory(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label htmlFor="blocker-note">补充说明（选填）</label>
      <textarea
        id="blocker-note"
        value={note}
        disabled={disabled}
        onChange={event => setNote(event.currentTarget.value)}
      />
      <div className="execution-actions">
        <button type="button" disabled={disabled || category === null} onClick={() => {
          if (!category) return;
          onSubmit({
            taskId: task?.id ?? null,
            blockerCategory: category,
            note: note.trim() ? note : null,
            minutesSpent: null,
            availableWeeklyMinutes: null,
          });
        }}>请教练帮我分析</button>
        <button type="button" className="button-secondary" disabled={disabled} onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}
