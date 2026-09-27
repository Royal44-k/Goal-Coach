"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useAccount } from "@/components/auth/auth-gate";
import { ModelReadinessSchema, type ModelReadiness as ModelReadinessResult } from "@/lib/public-api-schemas";

const statusCopy: Record<ModelReadinessResult["status"], string> = {
  mock_selected: "当前使用本机预设流程；未验证模型供应商连接。",
  configuration_missing: "服务器配置不完整。",
  configured_not_verified: "服务器配置已填写，但尚未验证供应商连接。",
};

export function ModelReadiness() {
  const invite = useAccount().session?.mode === "invite";
  const [readiness, setReadiness] = useState<ModelReadinessResult | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "error">("idle");

  async function check() {
    if (phase === "loading") return;
    setPhase("loading");
    try {
      setReadiness(await apiClient.request("/api/settings/model-readiness", { cache: "no-store" }, ModelReadinessSchema));
      setPhase("idle");
    } catch {
      setReadiness(null);
      setPhase("error");
    }
  }

  return (
    <section className="settings-card" aria-labelledby="model-readiness-title">
      <p className="section-kicker">模型状态</p><h2 id="model-readiness-title">服务器配置检查</h2>
      <p>此检查不会调用模型，也不会显示凭证或服务地址。</p>
      {readiness ? <>
        <p role="status">{readiness.provider === "deepseek" ? "DeepSeek：" : readiness.provider === "qwen" ? "阿里云百炼：" : ""}{invite ? statusCopy[readiness.status].replace("本机", "服务器") : statusCopy[readiness.status]}</p>
        <dl className="model-identifiers"><div><dt>主模型</dt><dd>{readiness.models.primary}</dd></div><div><dt>备选模型</dt><dd>{readiness.models.fallback ?? "无"}</dd></div></dl>
      </> : null}
      {phase === "error" ? <p className="inline-error" role="alert">无法读取模型配置状态，请重试。</p> : null}
      <button type="button" disabled={phase === "loading"} onClick={() => void check()}>{phase === "loading" ? "正在检查…" : "检查模型配置"}</button>
    </section>
  );
}
