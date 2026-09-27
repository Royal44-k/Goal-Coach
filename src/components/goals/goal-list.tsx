import Link from "next/link";
import type { GoalSummary } from "@/lib/public-api-schemas";

const statusLabel: Record<GoalSummary["status"], string> = {
  draft: "待完善",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
};

export function GoalList({ goals }: { goals: readonly GoalSummary[] }) {
  if (goals.length === 0) {
    return (
      <section className="empty-state" aria-labelledby="empty-goals-title">
        <h2 id="empty-goals-title">还没有目标</h2>
        <p>从一个真正想推进的结果开始，教练会和你一起把它拆成今天能做的行动。</p>
        <Link className="button-link" href="/goals/new" prefetch={false}>创建第一个目标</Link>
      </section>
    );
  }

  return (
    <section aria-labelledby="goal-list-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">继续推进</p>
          <h2 id="goal-list-title">你的目标</h2>
        </div>
        <Link className="text-link" href="/goals/new" prefetch={false}>创建目标</Link>
      </div>
      <ul className="goal-list">
        {goals.map(goal => (
          <li className="goal-card" key={goal.id}>
            <div className="goal-card__heading">
              <Link href={`/goals/${goal.id}`} prefetch={false}>{goal.title}</Link>
              <span>{statusLabel[goal.status]}</span>
            </div>
            <progress aria-label={`${goal.title}进度 ${goal.progress.percent}%`} max={100} value={goal.progress.percent} />
            <p>已完成 {goal.progress.completed} / {goal.progress.total} 项（{goal.progress.percent}%）</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
