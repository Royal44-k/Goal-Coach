"use client";

import type { Task } from "@/core/domain/contracts";
import type { NextActionResult } from "@/core/planning/next-action";

export function CurrentActionCard({
  result,
  hasBlockedTasks = false,
  disabled,
  onStart,
  onBlocked,
}: {
  result: NextActionResult | null;
  hasBlockedTasks?: boolean;
  disabled: boolean;
  onStart: (task: Task) => void;
  onBlocked: (task: Task) => void;
}) {
  return (
    <section className="current-action-card" aria-labelledby="current-action-title">
      <p className="section-kicker">当前行动</p>
      <h2 id="current-action-title">现在最值得做</h2>
      {result ? (
        <>
          <h3>{result.task.title}</h3>
          <p>{result.task.action}</p>
          <p className="current-action-card__slice">建议先做 {result.suggestedSliceMinutes} 分钟</p>
          <ul aria-label="推荐原因">
            {result.reasons.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
          <div className="execution-actions">
            <button type="button" disabled={disabled} onClick={() => onStart(result.task)}>开始这个任务</button>
            <button type="button" className="button-secondary" disabled={disabled} onClick={() => onBlocked(result.task)}>我卡住了</button>
          </div>
        </>
      ) : <p>{hasBlockedTasks ? "先解决阻塞" : "当前计划没有待执行任务"}</p>}
    </section>
  );
}
