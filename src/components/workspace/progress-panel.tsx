import type { Goal } from "@/core/domain/contracts";
import type { Progress } from "@/lib/public-api-schemas";

export function ProgressPanel({ goal, progress }: { goal: Goal; progress: Progress }) {
  return (
    <section className="progress-panel" aria-labelledby="formal-progress-title">
      <div>
        <p className="section-kicker">正式进度</p>
        <h2 id="formal-progress-title">{progress.percent}%</h2>
        <p>{progress.completed} / {progress.total} 个任务完成</p>
      </div>
      <progress aria-label="目标正式完成进度" max={100} value={progress.percent}>{progress.percent}%</progress>
      <dl>
        <div><dt>截止日期</dt><dd>{goal.deadline ?? "未设置"}</dd></div>
        <div><dt>每周预算</dt><dd>{goal.weeklyMinutes === null ? "未设置" : `${goal.weeklyMinutes} 分钟`}</dd></div>
      </dl>
    </section>
  );
}
