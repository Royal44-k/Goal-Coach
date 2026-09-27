"use client";

import { useState } from "react";
import type { Task } from "@/core/domain/contracts";
import type { EvidenceSubmission } from "@/core/planning/evidence";

const textLabels = {
  text: "文字说明",
  check_answer: "检查答案",
  user_declaration: "用户确认",
} as const;

export function EvidenceDialog({ task, disabled, onCancel, onSubmit }: {
  task: Task;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (evidence: EvidenceSubmission) => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const trimmed = text.trim();
  const ready = task.evidenceType === "file_metadata" ? file !== null : trimmed.length > 0;
  return (
    <section className="task-dialog" role="dialog" aria-modal="true" aria-labelledby="evidence-dialog-title">
      <h2 id="evidence-dialog-title">完成任务：{task.title}</h2>
      <p>完成状态与证据会作为同一次任务修改提交。</p>
      {task.evidenceType === "file_metadata" ? <label>选择证据文件
        <input type="file" disabled={disabled} onChange={event => setFile(event.currentTarget.files?.[0] ?? null)} />
      </label> : <label>{textLabels[task.evidenceType]}
        <textarea disabled={disabled} value={text} onChange={event => setText(event.currentTarget.value)} />
      </label>}
      <div className="execution-actions">
        <button type="button" disabled={disabled || !ready} onClick={() => {
          if (task.evidenceType === "file_metadata") {
            if (file) onSubmit({ type: "file_metadata", fileName: file.name, fileSize: file.size, mimeType: file.type || "application/octet-stream" });
          } else {
            onSubmit({ type: task.evidenceType, text: trimmed });
          }
        }}>确认完成并保存证据</button>
        <button type="button" className="button-secondary" disabled={disabled} onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}
