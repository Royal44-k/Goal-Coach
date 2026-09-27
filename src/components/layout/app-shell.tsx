"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { GoalSummary, PublicSettings } from "@/lib/public-api-schemas";
import { StatusBanner } from "@/components/ui/status-banner";
import { AccountControls } from "@/components/auth/account-controls";
import { useAccount } from "@/components/auth/auth-gate";
import { modelProviderName } from "@/lib/model-policy";
import { PWAControls } from "@/components/pwa/pwa-controls";

type ModelStatus = Pick<PublicSettings, "provider" | "apiKeyConfigured"> | null;

function modelStatus(settings: ModelStatus) {
  if (settings === null) return { tone: "neutral" as const, message: "正在读取本机设置。" };
  if (settings.provider === "mock") return { tone: "neutral" as const, message: "当前未连接模型，对话使用预设流程。" };
  const provider = modelProviderName(settings.provider);
  if (!settings.apiKeyConfigured) return { tone: "warning" as const, message: `已选择${provider}模型，但尚未检测到本机凭证。` };
  return { tone: "neutral" as const, message: `已选择${provider}模型，并已检测到本机凭证；首次对话前不会验证连接。` };
}

export function AppShell({ children, goals, settings }: {
  children: ReactNode;
  goals: readonly GoalSummary[];
  settings: ModelStatus;
}) {
  const { session } = useAccount();
  const status = modelStatus(settings);
  if (session?.mode === "invite") status.message = status.message.replaceAll("本机", "服务器");
  return (
    <>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="wordmark" href="/">自适应目标教练</Link>
          <details className="app-nav-details" open>
            <summary>目标导航</summary>
            <div className="app-nav-content">
              <nav aria-label="目标导航">
                <Link href="/">全部目标</Link>
                {goals.map(goal => <Link key={goal.id} href={`/goals/${goal.id}`} prefetch={false}>{goal.title}</Link>)}
              </nav>
              <Link className="settings-link" href="/settings" prefetch={false}>设置与数据</Link>
            </div>
          </details>
          <StatusBanner tone={status.tone}>{status.message}</StatusBanner>
          <AccountControls />
          <PWAControls />
        </aside>
        <main id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </>
  );
}
