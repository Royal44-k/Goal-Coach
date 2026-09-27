"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  apiClient,
  isReceivedApiError,
  isUnknownApiOutcomeError,
} from "@/lib/api-client";
import type { AppErrorCode } from "@/core/errors/app-error";
import {
  ApprovedPlanResultSchema,
  type ApprovedPlanResult,
  type PlanDraftArtifact,
  type ReplanDraftArtifact,
} from "@/lib/public-api-schemas";
import { PlanDiffView } from "./plan-diff-view";
import type { FreshMutationLease } from "@/components/workspace/use-recoverable-workspace-mutation";

const evidenceLabels = {
  text: "文字说明",
  file_metadata: "文件信息",
  check_answer: "检查答案",
  user_declaration: "用户确认",
} as const;

type ApprovalState = "idle" | "running" | "unknown" | "received" | "refresh_failed" | "approved_refresh_failed";
type PendingApproval = {
  body: Record<string, unknown>;
  lease: FreshMutationLease | null;
  identity: { goalId: string; generation: number };
};
type ApprovalActivity = Readonly<{ pending: PendingApproval; token: symbol }>;

type PlanReviewCardProps = {
  goalId: string;
  draft: PlanDraftArtifact | ReplanDraftArtifact;
  onRefresh: () => Promise<void>;
  onApproved: (result: ApprovedPlanResult) => void | Promise<void>;
  freshMutationBlocked?: boolean;
  tryAcquireFreshMutation?: (owner: "plan_approval") => FreshMutationLease | null;
  releaseFreshMutation?: (lease: FreshMutationLease) => void;
  approvalLabel?: string;
};

export function PlanReviewCard(props: PlanReviewCardProps) {
  return <PlanReviewCardForGoal key={props.goalId} {...props} />;
}

function PlanReviewCardForGoal({
  goalId,
  draft,
  onRefresh,
  onApproved,
  freshMutationBlocked = false,
  tryAcquireFreshMutation,
  releaseFreshMutation,
  approvalLabel,
}: PlanReviewCardProps) {
  const [state, setState] = useState<ApprovalState>("idle");
  const [receivedErrorCode, setReceivedErrorCode] = useState<AppErrorCode | null>(null);
  const lifecycle = useRef({ goalId, generation: 0, mounted: false });
  const request = useRef<PendingApproval | null>(null);
  const activity = useRef<ApprovalActivity | null>(null);
  const approvedResult = useRef<ApprovedPlanResult | null>(null);
  const names = new Map(draft.payload.tasks.map(task => [task.id, task.title]));

  useLayoutEffect(() => {
    const next = { goalId, generation: lifecycle.current.generation + 1, mounted: true };
    lifecycle.current = next;
    return () => {
      if (lifecycle.current.generation === next.generation) lifecycle.current = { goalId, generation: next.generation + 1, mounted: false };
    };
  }, [goalId]);

  function isCurrent(identity: { goalId: string; generation: number }) {
    return lifecycle.current.mounted && lifecycle.current.goalId === identity.goalId && lifecycle.current.generation === identity.generation;
  }

  function isPendingCurrent(pending: PendingApproval) {
    return request.current === pending && isCurrent(pending.identity);
  }

  function beginActivity(pending: PendingApproval): ApprovalActivity | null {
    if (activity.current || !isPendingCurrent(pending)) return null;
    const next = { pending, token: Symbol("plan-approval-activity") };
    activity.current = next;
    return next;
  }

  function isActivityCurrent(current: ApprovalActivity) {
    return activity.current === current && isPendingCurrent(current.pending);
  }

  function endActivity(current: ApprovalActivity) {
    if (activity.current === current) activity.current = null;
  }

  function release(current: ApprovalActivity) {
    const pending = current.pending;
    if (pending.lease && releaseFreshMutation && isActivityCurrent(current)) releaseFreshMutation(pending.lease);
  }

  async function approve(pending = request.current) {
    if (!pending) return;
    const currentActivity = beginActivity(pending);
    if (!currentActivity) return;
    request.current = pending;
    setState("running");
    let result: ApprovedPlanResult;
    try {
      try {
        result = await apiClient.request("/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pending.body),
        }, ApprovedPlanResultSchema);
      } catch (error) {
        if (!isActivityCurrent(currentActivity)) return;
        if (isUnknownApiOutcomeError(error)) {
          setState("unknown");
        } else if (isReceivedApiError(error)) {
          setReceivedErrorCode(error.code);
          try {
            if (!isActivityCurrent(currentActivity)) return;
            await onRefresh();
            if (!isActivityCurrent(currentActivity)) return;
            release(currentActivity);
            setState("received");
          } catch {
            if (isActivityCurrent(currentActivity)) setState("refresh_failed");
          }
        } else {
          setState("unknown");
        }
        return;
      }

      if (!isActivityCurrent(currentActivity)) return;
      approvedResult.current = result;
      try {
        if (!isActivityCurrent(currentActivity)) return;
        await onApproved(result);
        if (!isActivityCurrent(currentActivity)) return;
        release(currentActivity);
        setState("idle");
      } catch {
        if (isActivityCurrent(currentActivity)) setState("approved_refresh_failed");
      }
    } finally {
      endActivity(currentActivity);
    }
  }

  async function refreshApprovedResult() {
    const pending = request.current;
    const result = approvedResult.current;
    if (!result || !pending || state !== "approved_refresh_failed") return;
    const currentActivity = beginActivity(pending);
    if (!currentActivity) return;
    setState("running");
    try {
      try {
        if (!isActivityCurrent(currentActivity) || approvedResult.current !== result) return;
        await onApproved(result);
        if (!isActivityCurrent(currentActivity) || approvedResult.current !== result) return;
        release(currentActivity);
        setState("idle");
      } catch {
        if (isActivityCurrent(currentActivity)) setState("approved_refresh_failed");
      }
    } finally {
      endActivity(currentActivity);
    }
  }

  async function reconcileReceivedApproval() {
    const pending = request.current;
    if (!pending || state !== "refresh_failed") return;
    const currentActivity = beginActivity(pending);
    if (!currentActivity) return;
    setState("running");
    try {
      try {
        if (!isActivityCurrent(currentActivity)) return;
        await onRefresh();
        if (!isActivityCurrent(currentActivity)) return;
        release(currentActivity);
        setState("received");
      } catch {
        if (isActivityCurrent(currentActivity)) setState("refresh_failed");
      }
    } finally {
      endActivity(currentActivity);
    }
  }

  function approveCurrent() {
    if (freshMutationBlocked || activity.current) return;
    const lease = tryAcquireFreshMutation?.("plan_approval") ?? null;
    if (tryAcquireFreshMutation && !lease) return;
    const pending = {
      lease,
      identity: { goalId: lifecycle.current.goalId, generation: lifecycle.current.generation },
      body: {
      goalId,
      draftId: draft.id,
      toolName: "save_approved_plan",
      expectedDraftVersion: draft.version,
      operationId: crypto.randomUUID(),
      },
    };
    request.current = pending;
    approvedResult.current = null;
    setReceivedErrorCode(null);
    void approve(pending);
  }

  return (
    <section className="review-card" aria-label="计划草案">
      <div className="review-card__heading">
        <div><p className="section-kicker">批准前核对</p><h2>计划草案</h2></div>
        <p>草案版本 {draft.version} · 目标版本 {draft.payload.base.goalVersion}</p>
      </div>
      <section aria-labelledby="milestones-title">
        <h3 id="milestones-title">里程碑</h3>
        <ol className="milestone-list">{draft.payload.milestones.map(milestone => <li key={milestone}>{milestone}</li>)}</ol>
      </section>
      <section aria-labelledby="tasks-title">
        <h3 id="tasks-title">任务</h3>
        <ol className="plan-task-list">{draft.payload.tasks.map(task => (
          <li key={task.id} className="plan-task-card">
            <h4>{task.title}</h4>
            <dl>
              <div><dt>行动</dt><dd>{task.action}</dd></div>
              <div><dt>预计耗时</dt><dd>{task.estimateMinutes} 分钟</dd></div>
              <div><dt>截止日期</dt><dd>{task.dueAt ?? "未设置"}</dd></div>
              <div><dt>前置任务</dt><dd>{task.dependencyIds.length ? task.dependencyIds.map(id => names.get(id) ?? id).join("、") : "无"}</dd></div>
              <div><dt>完成标准</dt><dd>{task.doneCriteria}</dd></div>
              <div><dt>证据类型</dt><dd>{evidenceLabels[task.evidenceType]}</dd></div>
            </dl>
          </li>
        ))}</ol>
      </section>
      <PlanDiffView payload={draft.payload} />
      <button type="button" disabled={freshMutationBlocked || (state !== "idle" && state !== "received")} onClick={approveCurrent}>
        {`${approvalLabel ?? "批准计划"}（草案 ${draft.version} / 目标 ${draft.payload.base.goalVersion}）`}
      </button>
      {state === "unknown" ? <div className="recovery-panel"><p role="alert">无法确认这次批准是否执行。</p><button type="button" onClick={() => void approve()}>查询批准结果</button></div> : null}
      {state === "received" ? <p role="alert">{receivedErrorCode === "VERSION_CONFLICT" ? "草案已变化，请重新审阅" : "无法判断这次批准是否执行。已重新读取正式状态，请以页面中的计划为准。"}</p> : null}
      {state === "refresh_failed" ? <div className="recovery-panel"><p role="alert">无法判断这次批准是否执行，且目标状态读取失败。</p><button type="button" onClick={() => void reconcileReceivedApproval()}>重新读取目标状态</button><button type="button" onClick={() => void approve()}>查询批准结果</button></div> : null}
      {state === "approved_refresh_failed" ? <div className="recovery-panel"><p role="alert">计划已经批准，但重新读取目标状态失败。</p><button type="button" onClick={() => void refreshApprovedResult()}>重新读取目标状态</button></div> : null}
    </section>
  );
}
