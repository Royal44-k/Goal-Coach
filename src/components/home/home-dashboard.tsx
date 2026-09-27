"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GoalList } from "@/components/goals/goal-list";
import { AppShell } from "@/components/layout/app-shell";
import { useAccount } from "@/components/auth/auth-gate";
import { PrivacyGate } from "@/components/privacy/privacy-gate";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import { apiClient } from "@/lib/api-client";
import {
  GoalSummarySchema,
  PublicSettingsSchema,
  type GoalSummary,
  type PublicSettings,
} from "@/lib/public-api-schemas";
import { z } from "zod";

type HomeState =
  | { phase: "loading"; goals: GoalSummary[]; settings: PublicSettings | null }
  | { phase: "ready"; goals: GoalSummary[]; settings: PublicSettings }
  | { phase: "error"; goals: GoalSummary[]; settings: PublicSettings | null };

const goalsSchema = z.array(GoalSummarySchema);

async function requestHomeData() {
  const [settings, goals] = await Promise.all([
    apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema),
    apiClient.request("/api/goals", { cache: "no-store" }, goalsSchema),
  ]);
  return { settings, goals };
}

export function HomeDashboard() {
  const invite = useAccount().session?.mode === "invite";
  const [state, setState] = useState<HomeState>({ phase: "loading", goals: [], settings: null });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setState(previous => ({ ...previous, phase: "loading" }));
    try {
      const { settings, goals } = await requestHomeData();
      if (generation.current === currentGeneration) setState({ phase: "ready", settings, goals });
    } catch {
      if (generation.current === currentGeneration) {
        setState(previous => ({ ...previous, phase: "error" }));
      }
    }
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    void requestHomeData().then(
      ({ settings, goals }) => {
        if (generation.current === currentGeneration) setState({ phase: "ready", settings, goals });
      },
      () => {
        if (generation.current === currentGeneration) {
          setState(previous => ({ ...previous, phase: "error" }));
        }
      },
    );
    return () => { generation.current += 1; };
  }, []);

  async function acceptPrivacy() {
    if (state.settings === null) throw new Error("Settings unavailable");
    await apiClient.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: state.settings.version, privacyAccepted: true, privacyProvider: state.settings.provider, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION }),
    }, PublicSettingsSchema);
    await load();
  }

  return (
    <AppShell goals={state.goals} settings={state.settings}>
      <header className="page-intro">
        <p className="section-kicker">今天从这里开始</p>
        <h1>自适应目标教练</h1>
        <p>把目标变成今天能开始的行动</p>
      </header>
      {state.phase === "loading" ? <p className="loading-state" role="status">{invite ? "正在读取当前账号目标…" : "正在读取本机目标…"}</p> : null}
      {state.phase === "error" ? (
        <section className="load-error" aria-labelledby="load-error-title">
          <h2 id="load-error-title">{invite ? "无法读取账号状态" : "无法读取本机状态"}</h2>
          <p role="alert">{invite ? "请检查网络连接后重试。" : "请检查本机服务后重试。"}未知请求结果不代表没有发生更改。</p>
          <button type="button" onClick={() => void load()}>重新读取</button>
        </section>
      ) : null}
      {state.phase === "ready" ? (
        <PrivacyGate settings={state.settings} onAccept={acceptPrivacy} onReload={load}>
          <GoalList goals={state.goals} />
        </PrivacyGate>
      ) : null}
    </AppShell>
  );
}
