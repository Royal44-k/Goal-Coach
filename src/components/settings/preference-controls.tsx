"use client";

import { useState } from "react";
import type { UserPreference } from "@/core/domain/contracts";
import { EffectiveStrategiesInputSchema, PreferredTimeWindowInputSchema } from "@/lib/public-api-schemas";

const granularityLabels = { small: "较小", medium: "中等", large: "较大" } as const;
const blockerLabels = {
  cannot_start: "不知道如何开始",
  task_too_large: "任务太大，不知道怎么开始",
  insufficient_time: "时间不足",
  missing_resource: "缺少资源或信息",
  fear_of_error: "担心做错",
  prerequisite_incomplete: "前置条件尚未完成",
} as const;
export type EditablePreferences = { preferredTimeWindow: string | null; effectiveStrategies: string[] };

export function PreferenceControls({ preference, disabled, onSave, onClear }: {
  preference: UserPreference;
  disabled: boolean;
  onSave: (values: EditablePreferences) => void;
  onClear: () => void;
}) {
  const [timeWindow, setTimeWindow] = useState(preference.preferredTimeWindow ?? "");
  const [strategies, setStrategies] = useState(preference.effectiveStrategies.join("\n"));
  const [error, setError] = useState<string | null>(null);
  function save() {
    const preferredTimeWindow = timeWindow.trim() || null;
    const effectiveStrategies = strategies.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!PreferredTimeWindowInputSchema.safeParse(preferredTimeWindow).success) return setError("偏好时间段最多 120 个字符");
    if (!EffectiveStrategiesInputSchema.safeParse(effectiveStrategies).success) return setError("有效策略最多 10 条，每条最多 240 个字符");
    setError(null);
    onSave({ preferredTimeWindow, effectiveStrategies });
  }

  return (
    <section className="settings-card" aria-labelledby="preference-title">
      <p className="section-kicker">自适应信号</p><h2 id="preference-title">教练偏好</h2>
      <div className="preference-signals"><p>任务粒度 {granularityLabels[preference.taskGranularity]}</p><p>估时偏差 {preference.estimateBias.toFixed(2)}×</p><p>常见阻碍 {preference.commonBlockers.length ? preference.commonBlockers.map(value => blockerLabels[value]).join("、") : "暂无"}</p></div>
      <label>偏好时间段<input value={timeWindow} disabled={disabled} onChange={event => setTimeWindow(event.currentTarget.value)} /></label>
      <label>有效策略（每行一条）<textarea value={strategies} disabled={disabled} rows={5} onChange={event => setStrategies(event.currentTarget.value)} /></label>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <div className="settings-actions"><button type="button" disabled={disabled} onClick={save}>保存教练偏好（偏好 {preference.version}）</button><button type="button" className="button-secondary" disabled={disabled} onClick={onClear}>清除教练偏好</button></div>
    </section>
  );
}
