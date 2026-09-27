"use client";

import { useMemo, useRef, useState } from "react";
import type { Goal, GoalInput } from "@/core/domain/contracts";
import { CompleteGoalContractSchema } from "@/core/domain/contracts";
import {
  apiClient,
  isReceivedApiError,
  isUnknownApiOutcomeError,
} from "@/lib/api-client";
import {
  ApprovedContractResultSchema,
  SavedContractDraftSchema,
  type ApprovedContractResult,
  type ContractDraftArtifact,
} from "@/lib/public-api-schemas";

type ContractForm = {
  title: string;
  desiredOutcome: string;
  definitionOfDone: string;
  deadline: string;
  weeklyMinutes: string;
  constraints: string;
  motivation: string;
};

function formFrom(goal: Goal, draft: ContractDraftArtifact | null): ContractForm {
  const contract = draft?.payload.contract;
  return {
    title: contract?.title ?? goal.title,
    desiredOutcome: contract?.desiredOutcome ?? goal.desiredOutcome ?? "",
    definitionOfDone: contract?.definitionOfDone ?? goal.definitionOfDone ?? "",
    deadline: contract?.deadline ?? goal.deadline ?? "",
    weeklyMinutes: String(contract?.weeklyMinutes ?? goal.weeklyMinutes ?? ""),
    constraints: (contract?.constraints ?? goal.constraints ?? []).join("\n"),
    motivation: contract?.motivation ?? goal.motivation ?? "",
  };
}

function contractFrom(goal: Goal, form: ContractForm): GoalInput {
  const weekly = Number(form.weeklyMinutes);
  return {
    title: form.title.trim(),
    category: goal.category,
    desiredOutcome: form.desiredOutcome.trim() || null,
    definitionOfDone: form.definitionOfDone.trim() || null,
    deadline: form.deadline || null,
    weeklyMinutes: Number.isInteger(weekly) && weekly > 0 ? weekly : null,
    constraints: form.constraints.split("\n").map(value => value.trim()).filter(Boolean),
    motivation: form.motivation.trim() || null,
  };
}

function displayValue(value: GoalInput[keyof GoalInput]): string {
  if (Array.isArray(value)) return value.length ? value.join("、") : "无补充限制";
  if (typeof value === "number") return `${value} 分钟`;
  return value ?? "尚未填写";
}

type MutationState = "idle" | "running" | "unknown" | "received" | "refresh_failed" | "saved_refresh_failed" | "approved_refresh_failed";

export function GoalContractCard({
  goal,
  draft,
  onRefresh,
  onDraftSaved,
  onApproved,
}: {
  goal: Goal;
  draft: ContractDraftArtifact | null;
  onRefresh: () => Promise<void>;
  onDraftSaved: (draft: ContractDraftArtifact) => ContractDraftArtifact | null | Promise<ContractDraftArtifact | null>;
  onApproved: (result: ApprovedContractResult) => void | Promise<void>;
}) {
  const [currentDraft, setCurrentDraft] = useState(draft);
  const [manualOpen, setManualOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formFrom(goal, draft));
  const [saveState, setSaveState] = useState<MutationState>("idle");
  const [approvalState, setApprovalState] = useState<MutationState>("idle");
  const saveRequest = useRef<Record<string, unknown> | null>(null);
  const savedResult = useRef<ContractDraftArtifact | null>(null);
  const approvalRequest = useRef<Record<string, unknown> | null>(null);
  const approvedResult = useRef<ApprovedContractResult | null>(null);

  const contract = useMemo(() => contractFrom(goal, form), [form, goal]);
  const persisted = currentDraft?.payload.contract ?? null;
  const dirty = persisted === null || JSON.stringify(contract) !== JSON.stringify(persisted);
  const complete = CompleteGoalContractSchema.safeParse(persisted).success;
  const showForm = currentDraft !== null ? editing : manualOpen;
  const saveSettled = saveState === "idle" || saveState === "received";
  const approvalSettled = approvalState === "idle" || approvalState === "received";
  const freshMutationsEnabled = saveSettled && approvalSettled;

  function update(field: keyof ContractForm, value: string) {
    setForm(previous => ({ ...previous, [field]: value }));
  }

  function adoptAuthoritativeDraft(nextDraft: ContractDraftArtifact | null) {
    setCurrentDraft(nextDraft);
    setForm(formFrom(goal, nextDraft));
    setEditing(false);
    setManualOpen(false);
  }

  async function refreshAfterReceived(setState: (value: MutationState) => void) {
    try {
      await onRefresh();
      setState("received");
    } catch {
      setState("refresh_failed");
    }
  }

  async function save(body = saveRequest.current) {
    if (!body || saveState === "running" || !approvalSettled) return;
    saveRequest.current = body;
    setSaveState("running");
    try {
      const saved = await apiClient.request(`/api/goals/${goal.id}/contract-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, SavedContractDraftSchema);
      savedResult.current = saved;
      try {
        const authoritativeDraft = await onDraftSaved(saved);
        adoptAuthoritativeDraft(authoritativeDraft);
        setSaveState("idle");
      } catch {
        setSaveState("saved_refresh_failed");
      }
    } catch (error) {
      if (isUnknownApiOutcomeError(error)) setSaveState("unknown");
      else if (isReceivedApiError(error)) await refreshAfterReceived(setSaveState);
      else setSaveState("unknown");
    }
  }

  async function refreshSavedResult() {
    if (!savedResult.current || saveState !== "saved_refresh_failed") return;
    try {
      const authoritativeDraft = await onDraftSaved(savedResult.current);
      adoptAuthoritativeDraft(authoritativeDraft);
      setSaveState("idle");
    } catch {
      setSaveState("saved_refresh_failed");
    }
  }

  function saveCurrent() {
    if (!freshMutationsEnabled) return;
    const body = currentDraft ? {
      draftId: currentDraft.id,
      expectedDraftVersion: currentDraft.version,
      expectedGoalVersion: currentDraft.payload.baseGoalVersion,
      contract,
      operationId: crypto.randomUUID(),
    } : {
      expectedGoalVersion: goal.version,
      contract,
      operationId: crypto.randomUUID(),
    };
    void save(body);
  }

  async function approve(body = approvalRequest.current) {
    if (!body || approvalState === "running" || !saveSettled) return;
    approvalRequest.current = body;
    setApprovalState("running");
    let result: ApprovedContractResult;
    try {
      result = await apiClient.request("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, ApprovedContractResultSchema);
    } catch (error) {
      if (isUnknownApiOutcomeError(error)) setApprovalState("unknown");
      else if (isReceivedApiError(error)) await refreshAfterReceived(setApprovalState);
      else setApprovalState("unknown");
      return;
    }

    approvedResult.current = result;
    try {
      await onApproved(result);
      setApprovalState("idle");
    } catch {
      setApprovalState("approved_refresh_failed");
    }
  }

  async function refreshApprovedResult() {
    if (!approvedResult.current || approvalState !== "approved_refresh_failed") return;
    try {
      await onApproved(approvedResult.current);
      setApprovalState("idle");
    } catch {
      setApprovalState("approved_refresh_failed");
    }
  }

  function approveCurrent() {
    if (!currentDraft || dirty || !complete || !freshMutationsEnabled) return;
    void approve({
      goalId: goal.id,
      draftId: currentDraft.id,
      toolName: "save_approved_contract",
      expectedDraftVersion: currentDraft.version,
      operationId: crypto.randomUUID(),
    });
  }

  if (currentDraft === null && !manualOpen) {
    return (
      <section className="review-card" aria-labelledby="manual-contract-title">
        <h2 id="manual-contract-title">目标还需要补全</h2>
        <p>当前流程没有保存可批准的目标契约。你可以手动填写；打开或保存不会调用模型。</p>
        <button type="button" onClick={() => setManualOpen(true)}>手动填写目标</button>
      </section>
    );
  }

  return (
    <section className="review-card" aria-labelledby="contract-title">
      <div className="review-card__heading">
        <div>
          <p className="section-kicker">批准前核对</p>
          <h2 id="contract-title">目标契约</h2>
        </div>
        {currentDraft ? <p>草案版本 {currentDraft.version} · 目标版本 {currentDraft.payload.baseGoalVersion}</p> : <p>尚未保存</p>}
      </div>

      {showForm ? (
        <form aria-label="目标契约" onSubmit={event => { event.preventDefault(); saveCurrent(); }} className="contract-form">
          <label>目标名称<input value={form.title} onChange={event => update("title", event.target.value)} /></label>
          <label>期望成果<textarea value={form.desiredOutcome} onChange={event => update("desiredOutcome", event.target.value)} /></label>
          <label>完成标准<textarea value={form.definitionOfDone} onChange={event => update("definitionOfDone", event.target.value)} /></label>
          <label>截止日期<input type="date" value={form.deadline} onChange={event => update("deadline", event.target.value)} /></label>
          <label>每周投入分钟<input type="number" min="1" value={form.weeklyMinutes} onChange={event => update("weeklyMinutes", event.target.value)} /></label>
          <label>限制条件（每行一项）<textarea value={form.constraints} onChange={event => update("constraints", event.target.value)} /></label>
          <label>动机<textarea value={form.motivation} onChange={event => update("motivation", event.target.value)} /></label>
          <button type="submit" disabled={!freshMutationsEnabled}>
            {currentDraft
              ? `保存草案（基于草案 ${currentDraft.version} / 目标 ${currentDraft.payload.baseGoalVersion}）`
              : `保存草案（基于目标 ${goal.version}）`}
          </button>
        </form>
      ) : currentDraft ? (
        <dl className="contract-details">
          <div><dt>期望成果</dt><dd>{displayValue(currentDraft.payload.contract.desiredOutcome)}</dd></div>
          <div><dt>完成标准</dt><dd>{displayValue(currentDraft.payload.contract.definitionOfDone)}</dd></div>
          <div><dt>截止日期</dt><dd>{displayValue(currentDraft.payload.contract.deadline)}</dd></div>
          <div><dt>每周投入</dt><dd>{displayValue(currentDraft.payload.contract.weeklyMinutes)}</dd></div>
          <div><dt>限制条件</dt><dd>{displayValue(currentDraft.payload.contract.constraints)}</dd></div>
          <div><dt>动机</dt><dd>{displayValue(currentDraft.payload.contract.motivation)}</dd></div>
        </dl>
      ) : null}

      {currentDraft?.payload.assumptions.length ? (
        <section className="assumptions" aria-labelledby="assumptions-title">
          <h3 id="assumptions-title">暂定值说明</h3>
          <ul>{currentDraft.payload.assumptions.map(item => (
            <li key={item.field}><strong>{displayValue(currentDraft.payload.contract[item.field])}</strong>：{item.reason}</li>
          ))}</ul>
        </section>
      ) : null}

      {currentDraft && !editing ? <button type="button" disabled={!freshMutationsEnabled} onClick={() => setEditing(true)}>编辑目标契约</button> : null}
      {currentDraft ? (
        <button type="button" disabled={dirty || !complete || !freshMutationsEnabled} onClick={approveCurrent}>
          批准目标契约（草案 {currentDraft.version} / 目标 {currentDraft.payload.baseGoalVersion}）
        </button>
      ) : null}
      {currentDraft && !complete ? <p className="inline-error">请手动补全期望成果和完成标准后再批准。</p> : null}
      {saveState === "unknown" ? <div className="recovery-panel"><p role="alert">无法确认草案是否保存。请使用同一请求查询结果。</p><button type="button" onClick={() => void save()}>查询保存结果</button></div> : null}
      {approvalState === "unknown" ? <div className="recovery-panel"><p role="alert">无法确认这次批准是否执行。</p><button type="button" onClick={() => void approve()}>查询批准结果</button></div> : null}
      {saveState === "refresh_failed" ? <div className="recovery-panel"><p role="alert">草案保存结果已返回，但状态读取失败，请先重新读取。</p><button type="button" onClick={() => void refreshAfterReceived(setSaveState)}>重新读取目标状态</button><button type="button" onClick={() => void save()}>查询保存结果</button></div> : null}
      {saveState === "saved_refresh_failed" ? <div className="recovery-panel"><p role="alert">草案已经保存，但重新读取目标状态失败。</p><button type="button" onClick={() => void refreshSavedResult()}>重新读取目标状态</button></div> : null}
      {approvalState === "refresh_failed" ? <div className="recovery-panel"><p role="alert">批准结果已返回，但状态读取失败，请先重新读取。</p><button type="button" onClick={() => void refreshAfterReceived(setApprovalState)}>重新读取目标状态</button><button type="button" onClick={() => void approve()}>查询批准结果</button></div> : null}
      {approvalState === "approved_refresh_failed" ? <div className="recovery-panel"><p role="alert">目标契约已经批准，但重新读取目标状态失败。</p><button type="button" onClick={() => void refreshApprovedResult()}>重新读取目标状态</button></div> : null}
    </section>
  );
}
