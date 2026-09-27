"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppShell } from "@/components/layout/app-shell";
import { useAccount } from "@/components/auth/auth-gate";
import { PrivacyGate } from "@/components/privacy/privacy-gate";
import { hasCurrentModelConsent, MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import { DataControls, DELETED_COUNT_LABELS } from "@/components/settings/data-controls";
import { ModelSettings, type EditableModelSettings } from "@/components/settings/model-settings";
import { ModelReadiness } from "@/components/settings/model-readiness";
import { PreferenceControls, type EditablePreferences } from "@/components/settings/preference-controls";
import { UserPreferenceSchema, type UserPreference } from "@/core/domain/contracts";
import { apiClient, isReceivedApiError, isUnknownApiOutcomeError } from "@/lib/api-client";
import {
  ClearDataResultSchema,
  ExportBundleSchema,
  GoalSummarySchema,
  PublicSettingsSchema,
  type DeletedCounts,
  type GoalSummary,
  type PublicSettings,
} from "@/lib/public-api-schemas";

const goalsSchema = z.array(GoalSummarySchema);
type ReconcileKind = "settings" | "preferences";
type MutationState =
  | { phase: "idle" }
  | { phase: "running"; label: string }
  | { phase: "unknown"; kind: ReconcileKind; label: string }
  | { phase: "clear_unknown"; body: { confirmationPhrase: string; expectedSettingId: string; operationId: string } }
  | { phase: "reconcile_failed"; kind: ReconcileKind; label: string }
  | { phase: "privacy_reconcile_failed" }
  | { phase: "received_reconciled"; label: string }
  | { phase: "cleared_needs_settings" }
  | { phase: "privacy_unknown" }
  | { phase: "consent_data_failed" };

function localDateName(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `goal-coach-export-${year}-${month}-${day}.json`;
}

export default function SettingsPage() {
  const invite = useAccount().session?.mode === "invite";
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [preference, setPreference] = useState<UserPreference | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [mutation, setMutation] = useState<MutationState>({ phase: "idle" });
  const [deletedCounts, setDeletedCounts] = useState<DeletedCounts | null>(null);
  const [preferenceReset, setPreferenceReset] = useState(0);
  const [privacyGateReset, setPrivacyGateReset] = useState(0);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const generation = useRef(0);
  const mutationLocked = useRef(false);
  const activity = useRef<symbol | null>(null);

  const beginActivity = useCallback(() => {
    if (activity.current) return null;
    const token = Symbol("settings-activity");
    activity.current = token;
    return token;
  }, []);
  const endActivity = useCallback((token: symbol) => { if (activity.current === token) activity.current = null; }, []);
  const release = useCallback((token: symbol) => {
    if (activity.current !== token) return false;
    activity.current = null; mutationLocked.current = false; setMutationBlocked(false); return true;
  }, []);
  const acquire = useCallback((label: string) => {
    if (mutationLocked.current) return null;
    mutationLocked.current = true;
    const token = beginActivity();
    if (!token) { mutationLocked.current = false; return null; }
    setMutationBlocked(true);
    setMutation({ phase: "running", label });
    return token;
  }, [beginActivity]);

  const readKind = useCallback(async (kind: ReconcileKind, currentGeneration: number) => {
    if (kind === "settings") {
      const value = await apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema);
      if (generation.current !== currentGeneration) throw new Error("Settings generation changed");
      setSettings(value);
      if (!hasCurrentModelConsent(value)) setPreference(null);
      return;
    }
    const value = await apiClient.request("/api/settings/preferences", { cache: "no-store" }, UserPreferenceSchema);
    if (generation.current !== currentGeneration) throw new Error("Settings generation changed");
    setPreference(value);
  }, []);

  const loadConsented = useCallback(async (currentGeneration: number, nextSettings: PublicSettings) => {
    const [nextGoals, nextPreference] = await Promise.all([
      apiClient.request("/api/goals", { cache: "no-store" }, goalsSchema),
      apiClient.request("/api/settings/preferences", { cache: "no-store" }, UserPreferenceSchema),
    ]);
    if (generation.current !== currentGeneration) return;
    setSettings(nextSettings); setGoals(nextGoals); setPreference(nextPreference); setPhase("ready");
  }, []);

  const readPageData = useCallback(async (currentGeneration: number) => {
    try {
      const nextSettings = await apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema);
      if (generation.current !== currentGeneration) return;
      if (!hasCurrentModelConsent(nextSettings)) {
        const nextGoals = await apiClient.request("/api/goals", { cache: "no-store" }, goalsSchema);
        if (generation.current !== currentGeneration) return;
        setSettings(nextSettings); setGoals(nextGoals); setPreference(null); setPhase("ready");
      } else await loadConsented(currentGeneration, nextSettings);
    } catch {
      if (generation.current === currentGeneration) setPhase("error");
    }
  }, [loadConsented]);

  const load = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setPhase("loading");
    await readPageData(currentGeneration);
  }, [readPageData]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    void readPageData(currentGeneration);
    return () => { generation.current += 1; };
  }, [readPageData]);

  async function reconcile(kind: ReconcileKind, label: string) {
    if (!mutationLocked.current) return;
    const token = beginActivity();
    if (!token) return;
    const currentGeneration = generation.current;
    setMutation({ phase: "running", label });
    try {
      await readKind(kind, currentGeneration);
      release(token);
      setMutation({ phase: "received_reconciled", label });
    } catch {
      if (generation.current === currentGeneration && activity.current === token) {
        endActivity(token); setMutation({ phase: "reconcile_failed", kind, label });
      }
    }
  }

  async function runNonReplayable<T>(kind: ReconcileKind, label: string, request: () => Promise<T>, publish: (value: T) => void) {
    const token = acquire(label);
    if (!token) return;
    const currentGeneration = generation.current;
    try {
      const value = await request();
      if (generation.current !== currentGeneration) return;
      if (activity.current !== token) return;
      publish(value); release(token); setMutation({ phase: "idle" });
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      if (activity.current !== token) return;
      endActivity(token);
      if (isUnknownApiOutcomeError(error)) setMutation({ phase: "unknown", kind, label });
      else if (isReceivedApiError(error)) await reconcile(kind, label);
      else setMutation({ phase: "unknown", kind, label });
    }
  }

  function saveModel(values: EditableModelSettings) {
    if (!settings) return;
    const body = { expectedVersion: settings.version, ...values };
    void runNonReplayable("settings", "模型设置", () => apiClient.request("/api/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, PublicSettingsSchema), setSettings);
  }

  function withdrawPrivacy() {
    if (!settings || !hasCurrentModelConsent(settings)) return;
    void runNonReplayable("settings", "模型数据使用同意", () => apiClient.request("/api/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: settings.version, privacyAccepted: false }),
    }, PublicSettingsSchema), value => {
      setSettings(value);
      setPreference(null);
      setPrivacyGateReset(count => count + 1);
    });
  }

  function savePreferences(values: EditablePreferences) {
    if (!preference) return;
    const body = { expectedVersion: preference.version, ...values };
    void runNonReplayable("preferences", "教练偏好", () => apiClient.request("/api/settings/preferences", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, UserPreferenceSchema), setPreference);
  }

  function clearPreferences() {
    void runNonReplayable("preferences", "教练偏好", () => apiClient.request("/api/settings/preferences", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }, UserPreferenceSchema), value => { setPreference(value); setPreferenceReset(value => value + 1); });
  }

  async function exportData() {
    const token = acquire("数据导出");
    if (!token) return;
    const currentGeneration = generation.current;
    try {
      const data = await apiClient.request("/api/export", { cache: "no-store" }, ExportBundleSchema);
      if (generation.current !== currentGeneration || activity.current !== token) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = localDateName(); anchor.click(); URL.revokeObjectURL(url);
      release(token); setMutation({ phase: "idle" });
    } catch {
      if (generation.current === currentGeneration && activity.current === token) {
        release(token); setMutation({ phase: "received_reconciled", label: "数据导出失败，请重试。" });
      }
    }
  }

  async function publishClear(result: z.infer<typeof ClearDataResultSchema>, token: symbol) {
    const clearGeneration = ++generation.current;
    setDeletedCounts(result.deletedCounts); setSettings(null); setPreference(null); setGoals([]); setPhase("ready");
    setMutation({ phase: "running", label: "读取清除后的隐私设置" });
    try {
      const nextSettings = await apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema);
      if (generation.current !== clearGeneration) return;
      if (activity.current !== token) return;
      setSettings(nextSettings); release(token); setMutation({ phase: "idle" });
    } catch {
      if (generation.current === clearGeneration && activity.current === token) { endActivity(token); setMutation({ phase: "cleared_needs_settings" }); }
    }
  }

  async function executeClear(body: { confirmationPhrase: string; expectedSettingId: string; operationId: string }, replay = false) {
    if (replay && !mutationLocked.current) return;
    const token = replay ? beginActivity() : acquire(invite ? "永久清除当前账号数据" : "永久清除全部本机数据");
    if (!token) return;
    if (replay) setMutation({ phase: "running", label: "查询本次清除结果" });
    const currentGeneration = generation.current;
    try {
      const result = await apiClient.request("/api/data/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, ClearDataResultSchema);
      if (generation.current === currentGeneration && activity.current === token) await publishClear(result, token);
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      if (activity.current !== token) return;
      endActivity(token);
      if (isUnknownApiOutcomeError(error) || !isReceivedApiError(error)) setMutation({ phase: "clear_unknown", body });
      else {
        const readToken = beginActivity();
        if (!readToken) return;
        try { await readKind("settings", currentGeneration); release(readToken); setMutation({ phase: "received_reconciled", label: "清除请求收到失败响应；已重新读取设置。" }); }
        catch { if (activity.current === readToken) endActivity(readToken); setMutation({ phase: "reconcile_failed", kind: "settings", label: "清除请求" }); }
      }
    }
  }

  async function retryClearedSettings() {
    if (!mutationLocked.current) return;
    const token = beginActivity();
    if (!token) return;
    const currentGeneration = generation.current;
    setMutation({ phase: "running", label: "读取清除后的隐私设置" });
    try {
      const nextSettings = await apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema);
      if (generation.current !== currentGeneration) return;
      if (activity.current !== token) return;
      setSettings(nextSettings); release(token); setMutation({ phase: "idle" });
    } catch { if (generation.current === currentGeneration && activity.current === token) { endActivity(token); setMutation({ phase: "cleared_needs_settings" }); } }
  }

  async function acceptPrivacy() {
    if (!settings) return;
    const token = acquire("隐私确认");
    if (!token) return;
    const currentGeneration = generation.current;
    let accepted: PublicSettings;
    try {
      accepted = await apiClient.request("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: settings.version, privacyAccepted: true, privacyProvider: settings.provider, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION }) }, PublicSettingsSchema);
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      if (activity.current !== token) return;
      endActivity(token);
      if (isUnknownApiOutcomeError(error) || !isReceivedApiError(error)) { setMutation({ phase: "privacy_unknown" }); throw error; }
      const readToken = beginActivity();
      if (!readToken) throw error;
      try {
        const current = await apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema);
        if (generation.current !== currentGeneration || activity.current !== readToken) return;
        setSettings(current);
        if (hasCurrentModelConsent(current)) {
          try {
            await loadConsented(currentGeneration, current);
            if (generation.current !== currentGeneration || activity.current !== readToken) return;
            release(readToken); setMutation({ phase: "idle" }); return;
          }
          catch {
            if (generation.current === currentGeneration && activity.current === readToken) {
              endActivity(readToken); setMutation({ phase: "consent_data_failed" });
            }
            return;
          }
        }
        release(readToken); setMutation({ phase: "received_reconciled", label: "隐私确认收到失败响应；已重新读取设置。" });
      } catch { if (activity.current === readToken) { endActivity(readToken); setMutation({ phase: "privacy_reconcile_failed" }); } }
      throw error;
    }
    if (generation.current !== currentGeneration || activity.current !== token) return;
    setSettings(accepted);
    try {
      await loadConsented(currentGeneration, accepted);
      if (generation.current !== currentGeneration || activity.current !== token) return;
      release(token); setMutation({ phase: "idle" });
    } catch {
      if (generation.current === currentGeneration && activity.current === token) { endActivity(token); setMutation({ phase: "consent_data_failed" }); }
    }
  }

  async function reloadPrivacy() {
    if (!mutationLocked.current) return;
    const token = beginActivity();
    if (!token) return;
    const currentGeneration = generation.current;
    setMutation({ phase: "running", label: "重新读取隐私设置" });
    try {
      const current = await apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema);
      if (generation.current !== currentGeneration || activity.current !== token) return;
      setSettings(current);
      if (hasCurrentModelConsent(current)) {
        try {
          await loadConsented(currentGeneration, current);
        } catch {
          if (generation.current === currentGeneration && activity.current === token) {
            endActivity(token); setMutation({ phase: "consent_data_failed" });
          }
          return;
        }
        if (generation.current !== currentGeneration || activity.current !== token) return;
      }
      if (!release(token)) return;
      setMutation({ phase: "idle" });
      if (!hasCurrentModelConsent(current)) setPrivacyGateReset(value => value + 1);
    } catch { if (generation.current === currentGeneration && activity.current === token) { endActivity(token); setMutation({ phase: "privacy_reconcile_failed" }); } }
  }

  async function retryConsentData() {
    if (!settings) return;
    if (!mutationLocked.current) return;
    const token = beginActivity();
    if (!token) return;
    const currentGeneration = generation.current;
    setMutation({ phase: "running", label: "重新读取目标与教练偏好" });
    try {
      await loadConsented(currentGeneration, settings);
      if (generation.current !== currentGeneration || activity.current !== token) return;
      release(token); setMutation({ phase: "idle" });
    } catch { if (generation.current === currentGeneration && activity.current === token) { endActivity(token); setMutation({ phase: "consent_data_failed" }); } }
  }

  const disabled = mutationBlocked;
  return (
    <AppShell goals={goals} settings={settings}>
      <header className="page-intro"><p className="section-kicker">{invite ? "账号设置" : "本机控制"}</p><h1>设置与数据</h1><p>{invite ? "查看服务器模型设置，管理教练偏好与当前账号数据。" : "管理公开模型设置、教练偏好与本机数据。"}</p></header>
      {deletedCounts && !settings ? <section className="post-clear-notice"><h2>已清除的数据</h2><ul>{Object.entries(deletedCounts).map(([key, value]) => <li key={key}>{invite && key === "settings" ? "账号设置" : DELETED_COUNT_LABELS[key as keyof DeletedCounts] ?? key}：{value}</li>)}</ul><p>{invite ? "当前账号数据已清除；账号与每日新回合计数保留。" : "本机每日模型用量记录也已重置；这不是供应商计费额度。"}</p></section> : null}
      {phase === "loading" ? <p role="status">正在读取设置…</p> : null}
      {phase === "error" ? <section className="load-error"><h2>{invite ? "无法读取账号设置" : "无法读取本机设置"}</h2><button type="button" onClick={() => void load()}>重新读取</button></section> : null}
      {mutation.phase === "unknown" ? <section className="recovery-panel"><p role="alert">无法确认{mutation.label}是否已保存。先重新读取；不会自动重放这次写入。</p><button type="button" onClick={() => void reconcile(mutation.kind, mutation.label)}>重新读取{mutation.label}</button></section> : null}
      {mutation.phase === "reconcile_failed" ? <section className="recovery-panel"><p role="alert">{mutation.label}结果读取失败；不会自动再次写入。</p><button type="button" onClick={() => void reconcile(mutation.kind, mutation.label)}>重新读取{mutation.label}</button></section> : null}
      {mutation.phase === "privacy_reconcile_failed" ? <section className="recovery-panel"><p role="alert">隐私确认结果读取失败；不会自动再次写入。</p><button type="button" onClick={() => void reloadPrivacy()}>重新读取隐私确认</button></section> : null}
      {mutation.phase === "received_reconciled" ? <p role="alert">{mutation.label}；如需更改，请检查当前版本后再次明确保存。</p> : null}
      {mutation.phase === "clear_unknown" ? <section className="recovery-panel"><p role="alert">无法确认清除是否完成。只能使用同一请求编号查询。</p><button type="button" onClick={() => void executeClear(mutation.body, true)}>查询本次清除结果</button></section> : null}
      {mutation.phase === "cleared_needs_settings" ? <section className="recovery-panel"><p role="alert">数据已清除，但隐私设置读取失败。清除结果已经保留，不会再次清除。</p><button type="button" onClick={() => void retryClearedSettings()}>重新读取隐私设置</button></section> : null}
      {mutation.phase === "consent_data_failed" ? <section className="recovery-panel"><p role="alert">隐私确认已保存，但目标与偏好读取失败。不会再次提交隐私确认。</p><button type="button" onClick={() => void retryConsentData()}>重新读取目标与教练偏好</button></section> : null}
      {phase === "ready" && settings ? <DataControls key={settings.id} settingId={settings.id} disabled={disabled} deletedCounts={deletedCounts} onExport={() => void exportData()} onClear={confirmationPhrase => void executeClear({ confirmationPhrase, expectedSettingId: settings.id, operationId: crypto.randomUUID() })} /> : null}
      {phase === "ready" && settings && hasCurrentModelConsent(settings) ? <section className="settings-card" aria-label="模型数据使用同意"><h2>模型数据使用同意</h2><p>撤回后保留当前账号数据、模型提供方和每日额度；再次请求云模型前需要重新明确同意。已发出的请求无法撤回。</p><button type="button" className="button-secondary" disabled={disabled} onClick={withdrawPrivacy}>撤回模型数据使用同意</button></section> : null}
      {phase === "ready" && settings ? <div className="settings-grid"><ModelReadiness /><ModelSettings key={`${settings.id}:${settings.provider}`} settings={settings} disabled={disabled} readOnly={invite} onSave={saveModel} /></div> : null}
      {phase === "ready" && settings ? <PrivacyGate key={`${settings.id}:${privacyGateReset}`} settings={settings} onAccept={acceptPrivacy} onReload={reloadPrivacy}>
        {preference ? <div className="settings-grid"><PreferenceControls key={`${preference.id}:${preferenceReset}`} preference={preference} disabled={disabled} onSave={savePreferences} onClear={clearPreferences} /></div> : <p role="status">正在读取教练偏好…</p>}
      </PrivacyGate> : null}
    </AppShell>
  );
}
