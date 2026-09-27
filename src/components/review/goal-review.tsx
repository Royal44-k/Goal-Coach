"use client";

import { useState } from "react";
import type { ReviewReflection } from "@/lib/public-api-schemas";

export type GoalReviewSummary = {
  estimatedMinutes: number;
  actualMinutes: number;
  missingActualCount: number;
  blockers: string[];
  strategies: string[];
  planChanges: string[];
  reflection: ReviewReflection | null;
};

export function GoalReview({ summary, goalVersion, disabled, requestDisabled = false, onRequestReflection, onConfirm }: {
  summary: GoalReviewSummary;
  goalVersion: number;
  disabled: boolean;
  requestDisabled?: boolean;
  onRequestReflection: () => void;
  onConfirm: () => void;
}) {
  const snapshotKey = JSON.stringify({ goalVersion, summary });
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const confirmed = confirmedSnapshot === snapshotKey;
  return (
    <section className="goal-review" aria-labelledby="goal-review-title">
      <div className="goal-review__heading">
        <div><p className="section-kicker">完成前复盘</p><h2 id="goal-review-title">核对当前执行记录</h2></div>
        <button type="button" className="button-secondary" disabled={disabled || requestDisabled} onClick={onRequestReflection}>
          {summary.reflection ? "重新生成目标复盘" : "生成目标复盘"}
        </button>
      </div>
      <div className="goal-review__facts">
        <section><h3>预计与实际耗时</h3><p>预计 {summary.estimatedMinutes} 分钟；已记录实际 {summary.actualMinutes} 分钟{summary.missingActualCount ? `（${summary.missingActualCount} 项未记录）` : ""}</p></section>
        <section><h3>主要阻碍</h3>{summary.blockers.length ? <ul>{summary.blockers.map(value => <li key={value}>{value}</li>)}</ul> : <p>没有记录阻碍。</p>}</section>
        <section><h3>有效策略</h3>{summary.strategies.length ? <ul>{summary.strategies.map(value => <li key={value}>{value}</li>)}</ul> : <p>还没有记录有效策略。</p>}</section>
        <section><h3>计划调整记录</h3>{summary.planChanges.length ? <ul>{summary.planChanges.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul> : <p>计划没有调整记录。</p>}</section>
      </div>
      {summary.reflection ? (
        <section className="goal-review__reflection" aria-labelledby="saved-reflection-title">
          <h3 id="saved-reflection-title">已保存的生成复盘</h3>
          {summary.reflection.stale ? <p role="status">历史复盘：反馈已撤销，输入数据已变化。请依据当前记录核对，或重新生成。</p> : null}
          <p>{summary.reflection.message}</p>
          <p className="form-help">生成于 {new Date(summary.reflection.generatedAt).toLocaleString("zh-CN")}。内容基于生成时已保存的记录，可能不包含之后的修改；上方当前数据是本次确认的依据。</p>
          <label className="confirmation-check"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmedSnapshot(event.currentTarget.checked ? snapshotKey : null)} />确认已核对当前执行数据，并理解生成复盘可能早于后续修改</label>
          <button type="button" disabled={disabled || !confirmed} onClick={() => { if (confirmedSnapshot === snapshotKey) onConfirm(); }}>确认完成目标（目标 {goalVersion}）</button>
        </section>
      ) : <p className="form-help">请先显式生成并保存目标复盘；页面加载和刷新不会自动请求教练。</p>}
    </section>
  );
}
