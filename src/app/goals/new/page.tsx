"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppShell } from "@/components/layout/app-shell";
import { useAccount } from "@/components/auth/auth-gate";
import { PrivacyGate } from "@/components/privacy/privacy-gate";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import {
  apiClient,
  isReceivedApiError,
  isUnknownApiOutcomeError,
} from "@/lib/api-client";
import {
  AgentTurnResultSchema,
  CreateGoalResultSchema,
  GoalSummarySchema,
  PublicSettingsSchema,
  type GoalSummary,
  type PublicSettings,
} from "@/lib/public-api-schemas";

const goalsSchema = z.array(GoalSummarySchema);
type Category = "learning" | "light_work";
type CreatePhase = "idle" | "creating" | "creation_unknown" | "creation_reconciled" | "turn_running" | "turn_unknown" | "turn_received" | "refresh_failed";
type TurnRequest = { goalId: string; message: string; requestOperationId: string; explicitIntent: true };

export default function NewGoalPage() {
  const invite = useAccount().session?.mode === "invite";
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [category, setCategory] = useState<Category | "">("");
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<CreatePhase>("idle");
  const [createdGoalId, setCreatedGoalId] = useState<string | null>(null);
  const turnRequest = useRef<TurnRequest | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [nextSettings, nextGoals] = await Promise.all([
        apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema),
        apiClient.request("/api/goals", { cache: "no-store" }, goalsSchema),
      ]);
      if (generation.current !== current) return;
      setSettings(nextSettings);
      setGoals(nextGoals);
      setLoadFailed(false);
      return true;
    } catch {
      if (generation.current === current) setLoadFailed(true);
      throw new Error("Home state unavailable");
    }
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
    return () => { generation.current += 1; };
  }, [load]);

  async function acceptPrivacy() {
    if (!settings) throw new Error("Settings unavailable");
    await apiClient.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: settings.version, privacyAccepted: true, privacyProvider: settings.provider, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION }),
    }, PublicSettingsSchema);
    await load();
  }

  async function sendInitialTurn(request: TurnRequest, currentGeneration: number) {
    if (generation.current !== currentGeneration) return;
    turnRequest.current = request;
    setPhase("turn_running");
    try {
      await apiClient.request("/api/agent/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }, AgentTurnResultSchema);
      if (generation.current !== currentGeneration) return;
      // Creation and the first turn are persisted. Open a fresh document instead
      // of the intermittent first-goal Flight navigation seen in invite browsers.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Intentional persisted-resource boundary; do not restore the unstable Flight path here.
      globalThis.location.assign(`/goals/${request.goalId}`);
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      if (isUnknownApiOutcomeError(error)) setPhase("turn_unknown");
      else if (isReceivedApiError(error)) {
        try {
          await apiClient.request(`/api/goals/${request.goalId}`, { cache: "no-store" }, z.unknown());
          if (generation.current === currentGeneration) setPhase("turn_received");
        } catch {
          if (generation.current === currentGeneration) setPhase("refresh_failed");
        }
      } else setPhase("turn_unknown");
    }
  }

  async function createGoal(explicitDuplicate = false) {
    const initialMessage = message.trim();
    const allowed = phase === "idle" || (explicitDuplicate && phase === "creation_reconciled");
    if (!category || !initialMessage || !allowed) return;
    const currentGeneration = generation.current;
    setPhase("creating");
    try {
      const created = await apiClient.request("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, initialMessage }),
      }, CreateGoalResultSchema);
      if (generation.current !== currentGeneration) return;
      setCreatedGoalId(created.goal.id);
      await sendInitialTurn({ goalId: created.goal.id, message: initialMessage, requestOperationId: crypto.randomUUID(), explicitIntent: true }, currentGeneration);
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      if (isUnknownApiOutcomeError(error)) setPhase("creation_unknown");
      else setPhase("idle");
    }
  }

  async function reconcileUnknownCreation() {
    try {
      if (await load()) setPhase("creation_reconciled");
    } catch {
      // load() exposes the read failure without unlocking a duplicate creation.
    }
  }

  return (
    <AppShell goals={goals} settings={settings}>
      <header className="page-intro">
        <p className="section-kicker">从一句话开始</p>
        <h1>创建目标</h1>
        <p>先选择目标类型，再告诉教练你想完成什么。</p>
      </header>
      {loadFailed ? <section className="load-error"><h2>{invite ? "无法读取账号状态" : "无法读取本机状态"}</h2><button type="button" onClick={() => void load().catch(() => undefined)}>重新读取</button></section> : null}
      {settings ? (
        <PrivacyGate settings={settings} onAccept={acceptPrivacy} onReload={async () => { await load(); }}>
          <form className="new-goal-form" onSubmit={event => { event.preventDefault(); void createGoal(); }}>
            <fieldset>
              <legend>目标类型</legend>
              <label><input type="radio" name="category" value="learning" checked={category === "learning"} onChange={() => setCategory("learning")} />学习目标</label>
              <label><input type="radio" name="category" value="light_work" checked={category === "light_work"} onChange={() => setCategory("light_work")} />轻量工作</label>
            </fieldset>
            <label htmlFor="initial-goal">告诉教练你的目标</label>
            <textarea id="initial-goal" value={message} onChange={event => setMessage(event.target.value)} disabled={phase === "creating" || phase === "turn_running"} />
            <button type="submit" disabled={!category || !message.trim() || phase !== "idle"}>
              {phase === "creating" || phase === "turn_running" ? "正在创建…" : "创建并开始澄清"}
            </button>
          </form>

          {phase === "creation_unknown" || phase === "creation_reconciled" ? (
            <section className="recovery-panel">
              <h2>先确认是否已经创建</h2>
              <p role="alert">创建目标没有查询编号，无法安全自动重试。原始文字已保留，请先刷新目标列表并检查导航。</p>
              <button type="button" onClick={() => void reconcileUnknownCreation()}>刷新目标列表</button>
              <button type="button" disabled={phase !== "creation_reconciled"} onClick={() => void createGoal(true)}>仍要创建一个新目标</button>
            </section>
          ) : null}
          {phase === "turn_unknown" ? (
            <section className="recovery-panel">
              <h2>确认第一次澄清结果</h2>
              <p role="alert">目标已经创建，但无法确认第一次澄清是否完成。查询将使用同一请求编号。</p>
              <button type="button" onClick={() => { if (turnRequest.current) void sendInitialTurn(turnRequest.current, generation.current); }}>查询本次结果</button>
              {createdGoalId ? <Link href={`/goals/${createdGoalId}`}>打开目标工作区</Link> : null}
            </section>
          ) : null}
          {phase === "turn_received" || phase === "refresh_failed" ? (
            <section className="recovery-panel">
              <h2>目标已经创建</h2>
              <p role="alert">第一次澄清未能正常返回。请打开目标工作区，以正式状态决定下一步。</p>
              {createdGoalId ? <Link href={`/goals/${createdGoalId}`}>打开目标工作区</Link> : null}
            </section>
          ) : null}
        </PrivacyGate>
      ) : null}
    </AppShell>
  );
}
