"use client";

import { useState } from "react";
import { QWEN_FALLBACK_MODEL, QWEN_PRIMARY_MODEL, SettingsUpdateSchema, type PublicSettings } from "@/lib/public-api-schemas";
import { modelProviderName } from "@/lib/model-policy";

export type EditableModelSettings = Pick<PublicSettings, "provider" | "fallbackEnabled" | "dailyInputTokenLimit" | "dailyOutputTokenLimit">;
const editableSettingsSchema = SettingsUpdateSchema.pick({ provider: true, fallbackEnabled: true, dailyInputTokenLimit: true, dailyOutputTokenLimit: true }).required();

export function ModelSettings({ settings, disabled, readOnly = false, onSave }: { settings: PublicSettings; disabled: boolean; readOnly?: boolean; onSave: (values: EditableModelSettings) => void }) {
  const [provider, setProvider] = useState(settings.provider);
  const [fallbackEnabled, setFallbackEnabled] = useState(settings.fallbackEnabled);
  const [inputLimit, setInputLimit] = useState(String(settings.dailyInputTokenLimit));
  const [outputLimit, setOutputLimit] = useState(String(settings.dailyOutputTokenLimit));
  const [error, setError] = useState<string | null>(null);
  function save() {
    const parsed = editableSettingsSchema.safeParse({ provider, fallbackEnabled, dailyInputTokenLimit: Number(inputLimit), dailyOutputTokenLimit: Number(outputLimit) });
    if (!parsed.success) return setError("Token 上限必须是大于 0 的整数");
    setError(null); onSave(parsed.data);
  }
  if (readOnly) return <section className="settings-card" aria-labelledby="model-settings-title"><p className="section-kicker">模型配置</p><h2 id="model-settings-title">服务器运行设置</h2><p>由服务器管理员配置，账号不能修改模型或提高额度。</p><dl className="model-identifiers"><div><dt>提供方</dt><dd>{modelProviderName(settings.provider)}</dd></div><div><dt>主模型</dt><dd>{settings.model}</dd></div><div><dt>备选模型</dt><dd>{settings.provider === "deepseek" ? "无" : QWEN_FALLBACK_MODEL + (settings.fallbackEnabled ? "（启用）" : "（停用）")}</dd></div><div><dt>每日输入 / 输出 Token 上限</dt><dd>{settings.dailyInputTokenLimit} / {settings.dailyOutputTokenLimit}</dd></div></dl><p className="form-help">每个账号同时最多运行 1 个回合，全站最多 2 个；每日新回合额度由服务器设置。这里的限制不是供应商账单硬上限，超时等未知用量仍需管理员在供应商侧监控预算。</p></section>;
  return (
    <section className="settings-card" aria-labelledby="model-settings-title">
      <p className="section-kicker">模型配置</p><h2 id="model-settings-title">公开运行设置</h2>
      <dl className="model-identifiers"><div><dt>主模型</dt><dd>{provider === "deepseek" ? settings.provider === "deepseek" ? settings.model : "保存后由服务器确定" : QWEN_PRIMARY_MODEL}</dd></div><div><dt>备选模型</dt><dd>{provider === "deepseek" ? "无" : QWEN_FALLBACK_MODEL}</dd></div></dl>
      <label>模型提供方<select value={provider} disabled={disabled} onChange={event => setProvider(event.currentTarget.value as PublicSettings["provider"])}><option value="mock">本机预设流程</option><option value="qwen">阿里云百炼</option><option value="deepseek">DeepSeek</option></select></label>
      {provider === "deepseek" ? <p className="form-help">DeepSeek 当前使用固定主模型，不提供跨供应商备选模型。</p> : <label className="confirmation-check"><input type="checkbox" checked={fallbackEnabled} disabled={disabled} onChange={event => setFallbackEnabled(event.currentTarget.checked)} />启用备选模型</label>}
      <label>每日输入 Token 上限<input inputMode="numeric" value={inputLimit} disabled={disabled} onChange={event => setInputLimit(event.currentTarget.value)} /></label>
      <label>每日输出 Token 上限<input inputMode="numeric" value={outputLimit} disabled={disabled} onChange={event => setOutputLimit(event.currentTarget.value)} /></label>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <button type="button" disabled={disabled} onClick={save}>保存模型设置（设置 {settings.version}）</button>
    </section>
  );
}
