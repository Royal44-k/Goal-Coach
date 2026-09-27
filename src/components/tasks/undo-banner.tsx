"use client";

export function UndoBanner({ disabled, label, unavailableReason, onUndo }: { disabled: boolean; label: string; unavailableReason: string | null; onUndo: () => void }) {
  return (
    <section className="undo-banner" aria-label="撤销上一次修改">
      <div><strong>{label}</strong><p>任务修改会恢复状态和用时；反馈会标记为已撤销，不会删除已经提交的历史证据。</p>{unavailableReason ? <p>{unavailableReason}</p> : null}</div>
      <button type="button" disabled={disabled || unavailableReason !== null} onClick={onUndo}>撤销上一次修改</button>
    </section>
  );
}
