"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { isReceivedApiError, isUnknownApiOutcomeError } from "@/lib/api-client";
import type { PublicSettings } from "@/lib/public-api-schemas";
import { useAccount } from "@/components/auth/auth-gate";
import { hasCurrentModelConsent, modelProviderName } from "@/lib/model-policy";

type PrivacyGateProps = {
  settings: Pick<PublicSettings, "provider" | "privacyAcceptedAt" | "privacyProvider" | "privacyPolicyVersion">;
  onAccept: () => Promise<void> | void;
  onReload: () => Promise<void> | void;
  children: ReactNode;
};

type PrivacyFailure =
  | { kind: "unknown" }
  | { kind: "retryable"; message: string };

export function PrivacyGate({ settings, onAccept, onReload, children }: PrivacyGateProps) {
  const invite = useAccount().session?.mode === "invite";
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<PrivacyFailure | null>(null);
  const providerName = settings.provider === "deepseek" ? " DeepSeek" : modelProviderName(settings.provider);

  if (hasCurrentModelConsent(settings)) return children;

  async function accept() {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    try {
      await onAccept();
    } catch (error) {
      if (isUnknownApiOutcomeError(error)) {
        setFailure({ kind: "unknown" });
      } else if (isReceivedApiError(error)) {
        setFailure({ kind: "retryable", message: error.message });
      } else {
        setFailure({ kind: "retryable", message: "暂时无法保存隐私确认，请重试。" });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="privacy-gate" aria-labelledby="privacy-title">
      <p className="section-kicker">开始之前</p>
      <h2 id="privacy-title">先确认你的数据如何使用</h2>
      <p>{settings.provider === "mock" ? "当前使用预设流程，不会把目标内容发送给模型。此确认仅适用于预设流程。" : invite ? `你的账号和目标数据存储在运营者的服务器。你同意后，必要的目标内容会发送至${providerName}，用于生成建议。模型密钥由服务器管理员保管，不会显示在页面。` : `你同意后，必要的目标内容会发送至${providerName}，用于生成与你当前目标有关的建议。API Key 只保存在本机环境文件中，不会显示在页面或写入数据库。`}</p>
      <p>{settings.provider === "mock" ? "接受本告知本身不会发起模型请求。" : "切换到预设流程后，不会把目标内容发送给模型。接受本告知本身也不会发起模型请求。"}</p>
      <div className="privacy-actions">
        {failure?.kind === "unknown" ? (
          <button type="button" onClick={() => void onReload()}>重新读取当前状态</button>
        ) : (
          <button type="button" disabled={saving} onClick={accept}>
            {saving ? "正在保存…" : "我已理解并继续"}
          </button>
        )}
        <Link href="/settings#data-controls" prefetch={false}>查看数据与隐私设置</Link>
      </div>
      {failure === null ? null : (
        <p className="inline-error" role="alert">
          {failure.kind === "unknown"
            ? "无法确认隐私确认是否已保存。请重新读取当前状态，确认后再继续。"
            : failure.message}
        </p>
      )}
    </section>
  );
}
