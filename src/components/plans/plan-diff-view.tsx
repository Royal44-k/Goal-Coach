import type { PlanRevisionPayload } from "@/lib/public-api-schemas";

const sections = [
  ["added", "新增"],
  ["removed", "删除"],
  ["moved", "顺序变化"],
  ["changed", "内容变化"],
] as const;

export function PlanDiffView({ payload }: { payload: PlanRevisionPayload }) {
  const names = new Map(payload.tasks.map(task => [task.id, task.title]));
  return (
    <section className="plan-diff" aria-labelledby="plan-diff-title">
      <h3 id="plan-diff-title">与当前计划相比</h3>
      <div className="plan-diff__grid">
        {sections.map(([field, label]) => (
          <section key={field}>
            <h4>{label}</h4>
            {payload.diff[field].length ? (
              <ul>{payload.diff[field].map(id => <li key={id}>{names.get(id) ?? id}</li>)}</ul>
            ) : <p>无</p>}
          </section>
        ))}
      </div>
    </section>
  );
}
