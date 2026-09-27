"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { CheckInSchema, GoalSchema, TaskSchema, type Task, type TaskStatus } from "@/core/domain/contracts";
import type { AppErrorCode } from "@/core/errors/app-error";
import type { EvidenceSubmission } from "@/core/planning/evidence";
import { canTransition } from "@/core/state-machine/agent-state-machine";
import { isReviewEligible } from "@/core/planning/review-eligibility";
import { AgentChat } from "@/components/agent/agent-chat";
import { useAgentTurn } from "@/components/agent/use-agent-turn";
import { BlockerDialog, type BlockerReport } from "@/components/blockers/blocker-dialog";
import { DeleteGoalDialog } from "@/components/goals/delete-goal-dialog";
import { GoalContractCard } from "@/components/goals/goal-contract-card";
import { AppShell } from "@/components/layout/app-shell";
import { useAccount } from "@/components/auth/auth-gate";
import { PlanReviewCard } from "@/components/plans/plan-review-card";
import { ReplanReview } from "@/components/plans/replan-review";
import { PrivacyGate } from "@/components/privacy/privacy-gate";
import { hasCurrentModelConsent, MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import { GoalReview, type GoalReviewSummary } from "@/components/review/goal-review";
import { DeleteTaskDialog } from "@/components/tasks/delete-task-dialog";
import { EvidenceDialog } from "@/components/tasks/evidence-dialog";
import { TaskBoard } from "@/components/tasks/task-board";
import { TaskEditor, type TaskProposal } from "@/components/tasks/task-editor";
import { UndoBanner } from "@/components/tasks/undo-banner";
import { CurrentActionCard } from "./current-action-card";
import { ProgressPanel } from "./progress-panel";
import { useRecoverableWorkspaceMutation } from "./use-recoverable-workspace-mutation";
import {
  apiClient,
  isReceivedApiError,
  isUnknownApiOutcomeError,
} from "@/lib/api-client";
import {
  AgentTurnResultSchema,
  GOAL_REVIEW_REQUEST_MESSAGE,
  GoalSummarySchema,
  GoalWorkspaceSchema,
  PendingDraftSchema,
  PublicSettingsSchema,
  UndoResultSchema,
  type ContractDraftArtifact,
  type GoalSummary,
  type GoalWorkspace as GoalWorkspaceData,
  type PublicSettings,
} from "@/lib/public-api-schemas";

const goalsSchema = z.array(GoalSummarySchema);
const planDraftResponseSchema = PendingDraftSchema.refine(
  draft => draft.kind === "plan" || draft.kind === "replan",
  "Expected a plan draft",
);
const nullResultSchema = z.null();
const rejectReplanResultSchema = z.object({ draftId: z.uuid(), status: z.literal("rejected"), goal: GoalSchema }).strict();
const planMessage = "请根据已批准的目标契约生成计划草案。";
const blockerDiagnosisMessage = "我卡住了，请帮我分析。";
const replanRequestMessage = "请根据最新反馈调整计划。";
const replanRevisionMessage = "请重新提出调整方案。";
const blockerLabels = {
  cannot_start: "不知道如何开始",
  task_too_large: "任务太大，不知道怎么开始",
  insufficient_time: "时间不足",
  missing_resource: "缺少资源或信息",
  fear_of_error: "担心做错",
  prerequisite_incomplete: "前置条件尚未完成",
} as const;
const deletableAgentStates = new Set([
  "intake", "clarifying", "contract_review", "planning", "plan_review", "active", "paused", "completed",
]);
const statusLabels = {
  draft: "草拟中",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
} as const;

type LoadPhase = "loading" | "ready" | "error";
type PlanReconciliationKind = "unknown" | "received" | "success";
type PlanRequestState = {
  phase: "idle" | "running" | "unknown" | "received_reconciled" | "refresh_failed" | "success_refresh_failed";
  request: { goalId: string; message: string; requestOperationId: string; explicitIntent: true } | null;
  reconciliationKind: PlanReconciliationKind | null;
  receivedErrorCode: AppErrorCode | null;
};
type GoalIdentity = { goalId: string; generation: number };
type EditorSession = {
  goalId: string;
  tasks: Task[];
  expectedGoalVersion: number;
  expectedPlanVersion: { id: string; version: number };
};

async function requestWorkspaceData(goalId: string) {
  const [settings, goals, workspace] = await Promise.all([
    apiClient.request("/api/settings", { cache: "no-store" }, PublicSettingsSchema),
    apiClient.request("/api/goals", { cache: "no-store" }, goalsSchema),
    apiClient.request(`/api/goals/${goalId}`, { cache: "no-store" }, GoalWorkspaceSchema),
  ]);
  return { settings, goals, workspace };
}

export function GoalWorkspace({ goalId }: { goalId: string }) {
  return <GoalWorkspaceForGoal key={goalId} goalId={goalId} />;
}

function GoalWorkspaceForGoal({ goalId }: { goalId: string }) {
  const invite = useAccount().session?.mode === "invite";
  const router = useRouter();
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [workspace, setWorkspace] = useState<GoalWorkspaceData | null>(null);
  const [planRequest, setPlanRequest] = useState<PlanRequestState>({ phase: "idle", request: null, reconciliationKind: null, receivedErrorCode: null });
  const [editorSession, setEditorSession] = useState<EditorSession | null>(null);
  const [evidenceTask, setEvidenceTask] = useState<Task | null>(null);
  const [deleteTask, setDeleteTask] = useState<Task | null>(null);
  const [deleteGoalOpen, setDeleteGoalOpen] = useState(false);
  const [blockerTarget, setBlockerTarget] = useState<Task | null | undefined>(undefined);
  const loadGeneration = useRef(0);
  const lifecycle = useRef({ goalId, generation: 0, mounted: false });

  useLayoutEffect(() => {
    const next = { goalId, generation: lifecycle.current.generation + 1, mounted: true };
    lifecycle.current = next;
    return () => {
      if (lifecycle.current.generation === next.generation) {
        lifecycle.current = { goalId, generation: next.generation + 1, mounted: false };
      }
    };
  }, [goalId]);

  const currentIdentity = useCallback((): GoalIdentity => ({
    goalId: lifecycle.current.goalId,
    generation: lifecycle.current.generation,
  }), []);
  const isCurrent = useCallback((identity: GoalIdentity) => (
    lifecycle.current.mounted
    && lifecycle.current.goalId === identity.goalId
    && lifecycle.current.generation === identity.generation
  ), []);

  const refreshWorkspace = useCallback(async (identity = currentIdentity()) => {
    if (!isCurrent(identity)) throw new Error("Workspace changed");
    const currentLoad = ++loadGeneration.current;
    const next = await apiClient.request(`/api/goals/${goalId}`, { cache: "no-store" }, GoalWorkspaceSchema);
    if (!isCurrent(identity) || loadGeneration.current !== currentLoad || next.goal.id !== identity.goalId) throw new Error("Workspace changed");
    setWorkspace(next);
    setPhase("ready");
    return next;
  }, [currentIdentity, goalId, isCurrent]);

  const refreshContractDraft = useCallback(async () => {
    const identity = currentIdentity();
    const refreshed = await refreshWorkspace(identity);
    if (!isCurrent(identity)) throw new Error("Workspace changed");
    return refreshed.pendingDrafts.find(
      (candidate): candidate is ContractDraftArtifact => candidate.kind === "goal_contract",
    ) ?? null;
  }, [currentIdentity, isCurrent, refreshWorkspace]);

  const mutations = useRecoverableWorkspaceMutation({ goalId, currentIdentity, isCurrent, refreshWorkspace });
  const activeTurn = useAgentTurn(
    goalId,
    async () => { await refreshWorkspace(); },
    async () => { await refreshWorkspace(); },
    {
    tryAcquireFreshMutation: mutations.tryAcquireFreshMutation,
    releaseFreshMutation: mutations.releaseFreshMutation,
    isFreshMutationLeaseCurrent: mutations.isFreshMutationLeaseCurrent,
    },
  );

  const loadAll = useCallback(async (identity = currentIdentity()) => {
    if (!isCurrent(identity)) return null;
    const currentLoad = ++loadGeneration.current;
    await Promise.resolve();
    if (!isCurrent(identity)) return null;
    setPhase("loading");
    try {
      const { settings: nextSettings, goals: nextGoals, workspace: nextWorkspace } = await requestWorkspaceData(goalId);
      if (!isCurrent(identity) || loadGeneration.current !== currentLoad || nextWorkspace.goal.id !== identity.goalId) return null;
      setSettings(nextSettings);
      setGoals(nextGoals);
      setWorkspace(nextWorkspace);
      setPhase("ready");
      return nextWorkspace;
    } catch {
      if (isCurrent(identity) && loadGeneration.current === currentLoad) setPhase("error");
      return null;
    }
  }, [currentIdentity, goalId, isCurrent]);

  useEffect(() => {
    const identity = currentIdentity();
    const currentLoad = ++loadGeneration.current;
    void requestWorkspaceData(goalId).then(
      ({ settings: nextSettings, goals: nextGoals, workspace: nextWorkspace }) => {
        if (!isCurrent(identity) || loadGeneration.current !== currentLoad || nextWorkspace.goal.id !== identity.goalId) return;
        setSettings(nextSettings);
        setGoals(nextGoals);
        setWorkspace(nextWorkspace);
        setPlanRequest({ phase: "idle", request: null, reconciliationKind: null, receivedErrorCode: null });
        setEditorSession(null);
        setEvidenceTask(null);
        setDeleteTask(null);
        setDeleteGoalOpen(false);
        setBlockerTarget(undefined);
        setPhase("ready");
      },
      () => {
        if (isCurrent(identity) && loadGeneration.current === currentLoad) setPhase("error");
      },
    );
  }, [currentIdentity, goalId, isCurrent]);

  async function acceptPrivacy() {
    if (!settings) throw new Error("Settings unavailable");
    const identity = currentIdentity();
    await apiClient.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: settings.version, privacyAccepted: true, privacyProvider: settings.provider, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION }),
    }, PublicSettingsSchema);
    if (isCurrent(identity)) await loadAll(identity);
  }

  async function runPlanRequest(
    request: NonNullable<PlanRequestState["request"]>,
    identity = currentIdentity(),
    reconciliationKind: PlanReconciliationKind | null = null,
  ) {
    if (!isCurrent(identity) || request.goalId !== identity.goalId || !settings || !hasCurrentModelConsent(settings)) return;
    setPlanRequest({ phase: "running", request, reconciliationKind, receivedErrorCode: null });
    try {
      const result = await apiClient.request("/api/agent/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }, AgentTurnResultSchema);
      if (!isCurrent(identity)) return;
      try {
        await refreshWorkspace(identity);
        if (isCurrent(identity)) setPlanRequest({ phase: "idle", request: null, reconciliationKind: null, receivedErrorCode: null });
      } catch {
        if (isCurrent(identity)) setPlanRequest({ phase: "success_refresh_failed", request, reconciliationKind: "success", receivedErrorCode: null });
      }
      return result;
    } catch (error) {
      if (!isCurrent(identity)) return;
      if (isUnknownApiOutcomeError(error)) {
        setPlanRequest({ phase: "unknown", request, reconciliationKind: "unknown", receivedErrorCode: null });
      } else if (isReceivedApiError(error)) {
        try {
          await refreshWorkspace(identity);
          if (isCurrent(identity)) setPlanRequest({ phase: "received_reconciled", request, reconciliationKind: "received", receivedErrorCode: error.code });
        } catch {
          if (isCurrent(identity)) setPlanRequest({ phase: "refresh_failed", request, reconciliationKind: "received", receivedErrorCode: error.code });
        }
      } else {
        setPlanRequest({ phase: "unknown", request, reconciliationKind: "unknown", receivedErrorCode: null });
      }
    }
  }

  async function afterContractApproval() {
    const identity = currentIdentity();
    const refreshed = await refreshWorkspace(identity);
    if (!isCurrent(identity)) return;
    const pendingPlan = refreshed.pendingDrafts.some(draft => draft.kind === "plan" || draft.kind === "replan");
    if (refreshed.goal.id !== identity.goalId || refreshed.goal.status !== "draft" || refreshed.goal.agentState !== "planning" || pendingPlan || !settings || !hasCurrentModelConsent(settings)) return;
    const request = { goalId: identity.goalId, message: planMessage, requestOperationId: crypto.randomUUID(), explicitIntent: true as const };
    await runPlanRequest(request, identity);
  }

  async function afterPlanApproval() {
    const identity = currentIdentity();
    await refreshWorkspace(identity);
  }

  function explicitRegeneration() {
    if (!workspace || workspace.goal.status !== "draft" || workspace.goal.agentState !== "planning" || !settings || !hasCurrentModelConsent(settings)) return;
    if (workspace.pendingDrafts.some(draft => draft.kind === "plan" || draft.kind === "replan")) return;
    const identity = currentIdentity();
    void runPlanRequest({ goalId: identity.goalId, message: planMessage, requestOperationId: crypto.randomUUID(), explicitIntent: true }, identity);
  }

  async function reconcilePlanRequest() {
    const identity = currentIdentity();
    try {
      const refreshed = await refreshWorkspace(identity);
      if (!isCurrent(identity)) return;
      const saved = refreshed.pendingDrafts.some(draft => draft.kind === "plan" || draft.kind === "replan");
      setPlanRequest(previous => {
        if (saved) return { phase: "idle", request: null, reconciliationKind: null, receivedErrorCode: null };
        if (previous.reconciliationKind === "received") return { ...previous, phase: "received_reconciled" };
        if (previous.reconciliationKind === "unknown") return { ...previous, phase: "unknown" };
        return { ...previous, phase: previous.reconciliationKind === "success" ? "success_refresh_failed" : "refresh_failed" };
      });
    } catch {
      if (isCurrent(identity)) setPlanRequest(previous => ({
        ...previous,
        phase: previous.reconciliationKind === "success" ? "success_refresh_failed" : "refresh_failed",
      }));
    }
  }

  function taskPatch(taskId: string, expectedVersion: number, values: { status?: TaskStatus; actualMinutes?: number | null; evidence?: EvidenceSubmission }) {
    const current = workspace;
    if (!current?.currentPlan || current.goal.id !== goalId) return false;
    return mutations.startFreshMutation("execution", () => ({
      label: "任务修改",
      path: `/api/goals/${goalId}/tasks/${taskId}`,
      method: "PATCH",
      body: {
        expectedVersion,
        expectedGoalVersion: current.goal.version,
        expectedPlanVersion: { id: current.currentPlan!.id, version: current.currentPlan!.version },
        operationId: crypto.randomUUID(),
        source: "ui_explicit",
        ...values,
      },
      schema: TaskSchema,
    }));
  }

  function changeGoalStatus(status: "paused" | "active") {
    const current = workspace;
    if (!current || current.goal.id !== goalId) return;
    mutations.startFreshMutation("execution", () => ({
      label: "目标状态修改",
      path: `/api/goals/${goalId}`,
      method: "PATCH",
      body: { status, expectedVersion: current.goal.version, operationId: crypto.randomUUID() },
      schema: GoalSchema,
    }));
  }

  function completeGoal() {
    const current = workspace;
    if (!current || current.goal.id !== goalId) return;
    mutations.startFreshMutation("goal_completion", () => ({
      label: `目标完成（目标 ${current.goal.version}）`,
      path: `/api/goals/${goalId}`,
      method: "PATCH",
      body: { status: "completed", expectedVersion: current.goal.version, operationId: crypto.randomUUID() },
      schema: GoalSchema,
    }));
  }

  function removeGoal(confirmationPhrase: string) {
    const current = workspace;
    if (!current || current.goal.id !== goalId) return;
    const identity = currentIdentity();
    const expectedGoalVersion = current.goal.version;
    const admitted = mutations.startFreshMutation("goal_delete", () => ({
      label: `目标删除（目标 ${expectedGoalVersion}）`,
      path: `/api/goals/${goalId}`,
      method: "DELETE",
      body: {
        source: "ui_confirmation",
        confirmationPhrase,
        expectedGoalVersion,
        operationId: crypto.randomUUID(),
      },
      schema: nullResultSchema,
      readAuthoritativeState: async () => {
        const nextGoals = await apiClient.request("/api/goals", { cache: "no-store" }, goalsSchema);
        if (nextGoals.some(goal => goal.id === goalId)) {
          return { kind: "workspace" as const, workspace: await refreshWorkspace(identity) };
        }
        return {
          kind: "goal_absent" as const,
          goalId,
          publish: () => {
            loadGeneration.current += 1;
            setGoals(nextGoals);
            setWorkspace(null);
            setPlanRequest({ phase: "idle", request: null, reconciliationKind: null, receivedErrorCode: null });
            setEditorSession(null);
            setEvidenceTask(null);
            setDeleteTask(null);
            setDeleteGoalOpen(false);
            setBlockerTarget(undefined);
            router.replace("/");
          },
        };
      },
    }));
    if (admitted) setDeleteGoalOpen(false);
  }

  function openEditor() {
    const current = workspace;
    if (!current?.currentPlan || current.goal.id !== goalId) return;
    setEditorSession({
      goalId,
      tasks: current.tasks.map(task => ({ ...task, dependencyIds: [...task.dependencyIds] })),
      expectedGoalVersion: current.goal.version,
      expectedPlanVersion: { id: current.currentPlan.id, version: current.currentPlan.version },
    });
  }

  function submitManualPlan(proposal: TaskProposal) {
    const session = editorSession;
    if (!session || session.goalId !== goalId) return;
    const admitted = mutations.startFreshMutation("manual_plan", () => ({
      label: "计划草案",
      path: `/api/goals/${goalId}/plan-drafts`,
      method: "POST",
      body: {
        expectedPlanVersion: session.expectedPlanVersion,
        expectedGoalVersion: session.expectedGoalVersion,
        changeReason: proposal.changeReason,
        tasks: proposal.tasks,
        operationId: crypto.randomUUID(),
      },
      schema: planDraftResponseSchema,
    }));
    if (admitted) setEditorSession(null);
  }

  function submitEvidence(evidence: EvidenceSubmission) {
    if (!evidenceTask) return;
    const admitted = taskPatch(evidenceTask.id, evidenceTask.version, { status: "done", evidence });
    if (admitted) setEvidenceTask(null);
  }

  function removeTask(task: Task, confirmationPhrase: string) {
    const current = workspace;
    if (!current || current.goal.id !== goalId) return;
    const admitted = mutations.startFreshMutation("execution", () => ({
      label: "任务删除",
      path: `/api/goals/${goalId}/tasks/${task.id}`,
      method: "DELETE",
      body: {
        source: "ui_confirmation",
        confirmationPhrase,
        expectedTaskVersion: task.version,
        expectedGoalVersion: current.goal.version,
        operationId: crypto.randomUUID(),
      },
      schema: nullResultSchema,
    }));
    if (admitted) setDeleteTask(null);
  }

  function undoLastTaskChange() {
    const current = workspace;
    if (!current?.canUndo || !current.undoCandidate || current.goal.id !== goalId) return;
    const expectedUndoId = current.undoCandidate.id;
    mutations.startFreshMutation("execution", () => ({
      label: "撤销",
      path: `/api/goals/${goalId}/undo`,
      method: "POST",
      body: { operationId: crypto.randomUUID(), expectedUndoId, expectedGoalVersion: current.goal.version },
      schema: UndoResultSchema,
    }));
  }

  function submitBlockerReport(report: BlockerReport) {
    const current = workspace;
    if (!current || current.goal.id !== goalId) return;
    const admitted = mutations.startFreshMutation("blocker", () => ({
      label: "阻碍记录",
      path: `/api/goals/${goalId}/check-ins`,
      method: "POST",
      body: {
        ...report,
        kind: "blocker",
        expectedGoalVersion: current.goal.version,
        operationId: crypto.randomUUID(),
      },
      schema: CheckInSchema,
      continuationLabel: "继续请求教练分析",
      onConfirmed: (lease, refreshed) => (
        refreshed.goal.status === "active"
        && (refreshed.goal.agentState === "active" || refreshed.goal.agentState === "reviewing")
        && !!settings && hasCurrentModelConsent(settings)
        && activeTurn.sendWithLease(blockerDiagnosisMessage, lease)
      ),
    }));
    if (admitted) setBlockerTarget(undefined);
  }

  function rejectReplan(requestRevision: boolean) {
    const current = workspace;
    const draft = current?.pendingDrafts.find(candidate => candidate.kind === "replan");
    if (!current || !draft || current.goal.id !== goalId) return;
    mutations.startFreshMutation("replan_rejection", () => ({
      label: "重规划草案",
      path: `/api/goals/${goalId}/plan-drafts/${draft.id}/reject`,
      method: "POST",
      body: {
        expectedDraftVersion: draft.version,
        expectedGoalVersion: current.goal.version,
        operationId: crypto.randomUUID(),
      },
      schema: rejectReplanResultSchema,
      ...(requestRevision ? {
        continuationLabel: "继续请求教练修改方案",
        onConfirmed: (lease: Parameters<typeof activeTurn.sendWithLease>[1], refreshed: GoalWorkspaceData) => (
          refreshed.goal.status === "active"
          && (refreshed.goal.agentState === "active" || refreshed.goal.agentState === "reviewing")
          && !!settings && hasCurrentModelConsent(settings)
          && activeTurn.sendWithLease(replanRevisionMessage, lease)
        ),
      } : {}),
    }));
  }

  const visibleWorkspace = workspace?.goal.id === goalId ? workspace : null;
  const modelConsent = settings !== null && hasCurrentModelConsent(settings);
  const visiblePhase = visibleWorkspace === null && phase === "ready" ? "loading" : phase;
  const contractDraft = visibleWorkspace?.pendingDrafts.find(draft => draft.kind === "goal_contract") ?? null;
  const planDraft = visibleWorkspace?.pendingDrafts.find(draft => draft.kind === "plan" || draft.kind === "replan") ?? null;
  const canManuallyCreate = visibleWorkspace !== null
    && visibleWorkspace.goal.status === "draft"
    && (visibleWorkspace.goal.agentState === "intake" || visibleWorkspace.goal.agentState === "clarifying")
    && contractDraft === null;
  const canExecute = visibleWorkspace?.goal.status === "active"
    && (visibleWorkspace.goal.agentState === "active" || visibleWorkspace.goal.agentState === "reviewing");
  const canManualPlan = visibleWorkspace !== null && visibleWorkspace.currentPlan !== null && planDraft === null
    && ((visibleWorkspace.goal.status === "active" && visibleWorkspace.goal.agentState === "active")
      || (visibleWorkspace.goal.status === "paused" && visibleWorkspace.goal.agentState === "paused"));
  const canDeleteTask = visibleWorkspace !== null
    && ((visibleWorkspace.goal.status === "active" && visibleWorkspace.goal.agentState === "active")
      || (visibleWorkspace.goal.status === "paused" && visibleWorkspace.goal.agentState === "paused"));
  const canDeleteGoal = visibleWorkspace !== null && deletableAgentStates.has(visibleWorkspace.goal.agentState);
  const canReviewGoal = visibleWorkspace !== null
    && isReviewEligible(visibleWorkspace.goal, visibleWorkspace.currentPlan, visibleWorkspace.tasks)
    && ((visibleWorkspace.goal.status === "active" && visibleWorkspace.goal.agentState === "reviewing")
      || (visibleWorkspace.goal.status === "completed" && visibleWorkspace.goal.agentState === "completed"));
  const reviewSummary: GoalReviewSummary | null = canReviewGoal ? {
    estimatedMinutes: visibleWorkspace.tasks.reduce((total, task) => total + task.estimateMinutes, 0),
    actualMinutes: visibleWorkspace.tasks.reduce((total, task) => total + (task.actualMinutes ?? 0), 0),
    missingActualCount: visibleWorkspace.tasks.filter(task => task.actualMinutes === null).length,
    blockers: [...new Set(visibleWorkspace.effectiveCheckIns
      .filter(checkIn => checkIn.kind === "blocker" && checkIn.blockerCategory !== null)
      .flatMap(checkIn => [blockerLabels[checkIn.blockerCategory!], ...(checkIn.note ? [checkIn.note] : [])]))],
    strategies: visibleWorkspace.preference?.effectiveStrategies ?? [],
    planChanges: visibleWorkspace.planHistory.map(plan => `第 ${plan.number} 版：${plan.changeReason ?? (plan.number === 1 ? "初始计划" : "未记录调整原因")}`),
    reflection: visibleWorkspace.reviewReflection,
  } : null;
  const blockerReportTask = visibleWorkspace?.nextAction?.task
    ?? visibleWorkspace?.tasks.find(task => task.status === "blocked")
    ?? visibleWorkspace?.tasks.find(task => task.status === "todo" || task.status === "doing" || task.status === "skipped")
    ?? null;

  function retryActiveTurn() {
    const current = workspace;
    if (
      !modelConsent
      || !current
      || current.goal.id !== goalId
      || current.goal.status !== "active"
      || (current.goal.agentState !== "active" && current.goal.agentState !== "reviewing")
    ) return;
    void activeTurn.sendNew(activeTurn.request?.message ?? "");
  }

  return (
    <AppShell goals={goals} settings={settings}>
      {visiblePhase === "loading" ? <p className="loading-state" role="status">正在读取目标工作区…</p> : null}
      {visiblePhase === "error" && visibleWorkspace === null ? (
        <section className="load-error"><h1>无法读取目标工作区</h1><p role="alert">{invite ? "请检查网络连接后重试。" : "请检查本机服务后重试。"}</p><button type="button" onClick={() => void loadAll()}>重新读取</button></section>
      ) : null}
      {visibleWorkspace && settings ? (
        <>
          {!modelConsent ? <PrivacyGate settings={settings} onAccept={acceptPrivacy} onReload={async () => { await loadAll(); }}>{null}</PrivacyGate> : null}
          <header className="workspace-header">
            <p className="section-kicker">当前目标</p>
            <h1>{visibleWorkspace.goal.title}</h1>
            <p className={`goal-status goal-status--${visibleWorkspace.goal.status}`}>{statusLabels[visibleWorkspace.goal.status]}</p>
            <div className="workspace-header__actions">
              {visibleWorkspace.goal.status === "active" && canTransition(visibleWorkspace.goal.agentState, "paused") ? <button type="button" disabled={mutations.blocked} onClick={() => changeGoalStatus("paused")}>暂停目标</button> : null}
              {visibleWorkspace.goal.status === "paused" && canTransition(visibleWorkspace.goal.agentState, "active") ? <button type="button" disabled={mutations.blocked} onClick={() => changeGoalStatus("active")}>恢复目标</button> : null}
              {canDeleteGoal ? <button type="button" className="button-danger" disabled={mutations.blocked} onClick={() => setDeleteGoalOpen(true)}>删除目标</button> : null}
            </div>
          </header>

          {visibleWorkspace.currentPlan ? (
            <section className="approved-plan" aria-labelledby="approved-plan-title">
              <h2 id="approved-plan-title">当前已批准计划</h2>
              <h3>里程碑</h3>
              <ol aria-label="当前计划里程碑">{visibleWorkspace.currentPlan.milestones.map(milestone => <li key={milestone}>{milestone}</li>)}</ol>
            </section>
          ) : null}

          {visibleWorkspace.currentPlan ? <>
            <ProgressPanel goal={visibleWorkspace.goal} progress={visibleWorkspace.progress} />
            <CurrentActionCard
              result={visibleWorkspace.nextAction}
              hasBlockedTasks={visibleWorkspace.tasks.some(task => task.status === "blocked")}
              disabled={mutations.blocked || !canExecute}
              onStart={task => taskPatch(task.id, task.version, { status: "doing" })}
              onBlocked={task => taskPatch(task.id, task.version, { status: "blocked" })}
            />
            <section className="adaptation-panel" aria-labelledby="blocker-report-title">
              <div>
                <p className="section-kicker">遇到阻碍</p>
                <h2 id="blocker-report-title">记录后再请教练分析</h2>
                <p>{blockerReportTask ? `将关联任务：${blockerReportTask.title}` : "当前没有可关联的任务，将记录为目标级阻碍。"}</p>
              </div>
              <button type="button" className="button-secondary" disabled={mutations.blocked || !canExecute} onClick={() => setBlockerTarget(blockerReportTask)}>报告阻碍</button>
            </section>
            {visibleWorkspace.replanTriggers.length ? (
              <section className="adaptation-panel adaptation-panel--warning" aria-labelledby="replan-trigger-title">
                <div>
                  <p className="section-kicker">确定性信号</p>
                  <h2 id="replan-trigger-title">计划可能需要调整</h2>
                  <ul>{visibleWorkspace.replanTriggers.map((trigger, index) => <li key={`${trigger.code}-${trigger.taskId ?? index}`}>{trigger.reason}</li>)}</ul>
                </div>
                <button type="button" disabled={!modelConsent || mutations.blocked || activeTurn.phase !== "idle" || visibleWorkspace.goal.status !== "active"} onClick={() => { if (modelConsent) void activeTurn.send(replanRequestMessage); }}>请教练评估</button>
              </section>
            ) : null}
            {activeTurn.phase === "idle" && activeTurn.result?.advice && activeTurn.result.adviceGoalVersion === visibleWorkspace.goal.version ? (
              <section className="advice-card" aria-labelledby="minimum-next-step-title">
                <p className="section-kicker">教练建议</p>
                <h2 id="minimum-next-step-title">最小下一步</h2>
                <p className="advice-card__step">{activeTurn.result.advice.minimumNextStep}</p>
                <p>{activeTurn.result.advice.explanation}</p>
              </section>
            ) : null}
            <TaskBoard
              tasks={visibleWorkspace.tasks}
              evidence={visibleWorkspace.evidence}
              disabled={mutations.blocked}
              canExecute={canExecute}
              canEdit={canManualPlan}
              canDelete={canDeleteTask}
              onStatusChange={(taskId, version, status) => taskPatch(taskId, version, { status })}
              onMinutesChange={(taskId, version, actualMinutes) =>
                taskPatch(taskId, version, { actualMinutes })
              }
              onComplete={task => setEvidenceTask(task)}
              onEdit={openEditor}
              onEditPlan={canManualPlan ? openEditor : undefined}
              onDelete={task => setDeleteTask(task)}
            />
            {visibleWorkspace.undoCandidate ? <UndoBanner disabled={mutations.blocked || !visibleWorkspace.canUndo} label={visibleWorkspace.undoCandidate.label} unavailableReason={visibleWorkspace.undoUnavailableReason} onUndo={undoLastTaskChange} /> : null}
            {visibleWorkspace.checkIns.length ? <details className="undo-banner"><summary>反馈历史（{visibleWorkspace.checkIns.length}）</summary><ul>{visibleWorkspace.checkIns.map(checkIn => <li key={checkIn.id}><strong>{checkIn.withdrawnAt ? "已撤销" : "已记录"}</strong> · {checkIn.note ?? (checkIn.kind === "availability_change" ? `每周可用 ${checkIn.availableWeeklyMinutes} 分钟` : "打卡反馈")}{checkIn.withdrawnAt ? <span>（仅保留历史，不参与当前分析）</span> : null}</li>)}</ul></details> : null}
          </> : null}

          {reviewSummary ? <GoalReview
            summary={reviewSummary}
            goalVersion={visibleWorkspace.goal.version}
            disabled={mutations.blocked || activeTurn.phase !== "idle" || visibleWorkspace.goal.status === "completed"}
            requestDisabled={!modelConsent}
            onRequestReflection={() => { if (modelConsent) void activeTurn.send(GOAL_REVIEW_REQUEST_MESSAGE, true); }}
            onConfirm={completeGoal}
          /> : null}

          {editorSession ? <TaskEditor tasks={editorSession.tasks} disabled={mutations.blocked} onCancel={() => setEditorSession(null)} onSubmit={submitManualPlan} /> : null}
          {evidenceTask ? <EvidenceDialog task={evidenceTask} disabled={mutations.blocked} onCancel={() => setEvidenceTask(null)} onSubmit={submitEvidence} /> : null}
          {deleteTask ? <DeleteTaskDialog task={deleteTask} dependentTasks={visibleWorkspace.tasks.filter(task => task.dependencyIds.includes(deleteTask.id))} disabled={mutations.blocked || !canDeleteTask} onCancel={() => setDeleteTask(null)} onConfirm={removeTask} /> : null}
          {deleteGoalOpen ? <DeleteGoalDialog title={visibleWorkspace.goal.title} version={visibleWorkspace.goal.version} disabled={mutations.blocked || !canDeleteGoal} onCancel={() => setDeleteGoalOpen(false)} onConfirm={removeGoal} /> : null}
          {blockerTarget !== undefined ? <BlockerDialog task={blockerTarget} disabled={mutations.blocked} onCancel={() => setBlockerTarget(undefined)} onSubmit={submitBlockerReport} /> : null}

          {contractDraft ? (
            <GoalContractCard
              key={`${contractDraft.id}:${contractDraft.version}`}
              goal={visibleWorkspace.goal}
              draft={contractDraft}
              onRefresh={async () => { await refreshWorkspace(); }}
              onDraftSaved={refreshContractDraft}
              onApproved={afterContractApproval}
            />
          ) : null}
          {canManuallyCreate ? (
            <GoalContractCard
              key={`${visibleWorkspace.goal.id}:${visibleWorkspace.goal.version}:manual`}
              goal={visibleWorkspace.goal}
              draft={null}
              onRefresh={async () => { await refreshWorkspace(); }}
              onDraftSaved={refreshContractDraft}
              onApproved={afterContractApproval}
            />
          ) : null}
          {planDraft && planDraft.kind === "replan" && visibleWorkspace.currentPlan ? <ReplanReview
            goalId={goalId}
            goalStatus={visibleWorkspace.goal.status}
            goalVersion={visibleWorkspace.goal.version}
            currentPlan={visibleWorkspace.currentPlan}
            draft={planDraft}
            disabled={mutations.blocked}
            onKeepCurrent={() => rejectReplan(false)}
            onRequestRevision={() => rejectReplan(true)}
            onRefresh={async () => { await refreshWorkspace(); }}
            onApproved={afterPlanApproval}
            tryAcquireFreshMutation={mutations.tryAcquireFreshMutation}
            releaseFreshMutation={mutations.releaseFreshMutation}
          /> : planDraft ? <PlanReviewCard
            goalId={goalId}
            draft={planDraft}
            onRefresh={async () => { await refreshWorkspace(); }}
            onApproved={afterPlanApproval}
            freshMutationBlocked={mutations.blocked}
            tryAcquireFreshMutation={mutations.tryAcquireFreshMutation}
            releaseFreshMutation={mutations.releaseFreshMutation}
          /> : null}

          {mutations.state.phase !== "idle" ? <section className="recovery-panel" aria-labelledby="workspace-mutation-title">
            <h2 id="workspace-mutation-title">{mutations.state.request?.label ?? "正式状态"}</h2>
            {mutations.state.phase === "running" ? <p role="status">正在保存并重新读取正式状态…</p> : null}
            {mutations.state.phase === "unknown" ? <><p role="alert">无法确认这次修改是否执行。查询会重放同一请求编号和内容。</p><button type="button" onClick={() => void mutations.refreshUnknownMutation()}>重新读取正式状态</button><button type="button" onClick={mutations.replayExactMutation}>查询本次修改结果</button></> : null}
            {mutations.state.phase === "success_refresh_failed" ? <><p role="alert">{mutations.state.request?.label ?? "修改"}已经保存，但重新读取正式状态失败。</p><button type="button" onClick={() => void mutations.reconcileMutation()}>重新读取正式状态</button></> : null}
            {mutations.state.phase === "refresh_failed" ? <><p role="alert">服务已返回错误，但重新读取正式状态失败。</p><button type="button" onClick={() => void mutations.reconcileMutation()}>重新读取正式状态</button></> : null}
            {mutations.state.phase === "received_reconciled" ? <p role="alert">{mutations.state.receivedErrorCode === "VERSION_CONFLICT" ? "当前数据版本已变化，已刷新；请核对后重试。" : "服务已返回错误；已重新读取正式状态。"}</p> : null}
            {mutations.state.phase === "confirmed_needs_continuation" ? <>
              <p role="status">{mutations.state.request?.label ?? "修改"}已保存并已重新读取正式状态。接下来的教练请求需要你再次确认。</p>
              <button type="button" onClick={mutations.continueConfirmedMutation}>{mutations.state.request?.continuationLabel ?? "继续"}</button>
              <button type="button" className="button-secondary" onClick={mutations.cancelConfirmedContinuation}>{mutations.state.request?.label === "阻碍记录" ? "仅保留已保存的阻碍记录" : "仅保留已保存的修改"}</button>
            </> : null}
          </section> : null}

          {activeTurn.phase !== "idle" ? (
            <section className="recovery-panel" aria-labelledby="active-turn-title">
              <h2 id="active-turn-title">教练请求</h2>
              <p>{activeTurn.request?.message}</p>
              {activeTurn.phase === "running" ? <p role="status">正在请教练评估…</p> : null}
              {activeTurn.phase === "unknown_outcome" ? <><p role="alert">无法确认这次教练请求是否完成。查询会使用同一请求编号。</p><button type="button" disabled={!modelConsent} onClick={() => { if (modelConsent) void activeTurn.lookup(); }}>查询本次教练结果</button><button type="button" onClick={() => void activeTurn.refresh()}>重新读取目标状态</button></> : null}
              {activeTurn.phase === "received_reconciled" ? <><p role="alert">{activeTurn.receivedErrorCode === "MODEL_TIMEOUT" ? "模型响应超时，已进入手动模式。正式目标和已有任务仍可使用；再次请求教练会创建新一轮。" : "服务已返回错误；已重新读取目标状态。"}</p><button type="button" disabled={!modelConsent || !canExecute} onClick={retryActiveTurn}>显式发起新一轮</button></> : null}
              {activeTurn.phase === "refresh_failed" ? <><p role="alert">{activeTurn.receivedErrorCode === "MODEL_TIMEOUT" ? "模型响应超时，且目标状态读取失败。请先重新读取目标状态。" : "服务已返回错误，且目标状态读取失败。"}</p><button type="button" onClick={() => void activeTurn.refresh()}>重新读取目标状态</button><button type="button" disabled={!modelConsent} onClick={() => { if (modelConsent) void activeTurn.lookup(); }}>查询本次教练结果</button></> : null}
              {activeTurn.phase === "success_refresh_failed" ? <><p role="alert">教练回复已经收到，但重新读取目标状态失败。</p><button type="button" onClick={() => void activeTurn.refresh()}>重新读取目标状态</button></> : null}
            </section>
          ) : null}

          {planRequest.phase !== "idle" ? (
            <section className="recovery-panel" aria-labelledby="plan-generation-title">
              <h2 id="plan-generation-title">生成计划草案</h2>
              <p>{planMessage}</p>
              {planRequest.phase === "running" ? <p role="status">正在生成计划草案…</p> : null}
              {planRequest.phase === "unknown" ? <><p role="alert">无法确认计划草案是否生成。查询会使用同一请求编号。</p><button type="button" disabled={!modelConsent} onClick={() => { if (planRequest.request) void runPlanRequest(planRequest.request, currentIdentity(), planRequest.reconciliationKind); }}>查询本次结果</button></> : null}
              {planRequest.phase === "received_reconciled" && visibleWorkspace.goal.agentState === "planning" && !planDraft ? <><p role="alert">{planRequest.receivedErrorCode === "MODEL_TIMEOUT" ? "模型响应超时，已进入手动恢复模式。已保存目标仍保留；当前尚无计划任务，可重新生成计划草案或返回使用可用的目标控件。" : "服务已返回错误；重新读取后仍没有计划草案。再次生成可能执行新的工作。"}</p><button type="button" disabled={!modelConsent} onClick={explicitRegeneration}>重新生成计划草案</button></> : null}
              {planRequest.phase === "refresh_failed" ? <><p role="alert">{planRequest.receivedErrorCode === "MODEL_TIMEOUT" ? "模型响应超时，且目标状态读取失败。请先重新读取目标状态；确认前请勿重新生成。" : "请求结果与后续状态读取必须分开确认；请重新读取目标状态。"}</p><button type="button" onClick={() => void reconcilePlanRequest()}>重新读取目标状态</button><button type="button" disabled={!modelConsent} onClick={() => { if (planRequest.request) void runPlanRequest(planRequest.request, currentIdentity(), planRequest.reconciliationKind); }}>查询本次结果</button></> : null}
              {planRequest.phase === "success_refresh_failed" ? <><p role="alert">计划草案已经生成，但重新读取目标状态失败。</p><button type="button" onClick={() => void reconcilePlanRequest()}>重新读取目标状态</button></> : null}
            </section>
          ) : null}

          {modelConsent && visibleWorkspace.goal.status === "draft" && !planDraft ? (
            <AgentChat
              key={goalId}
              goalId={goalId}
              initialMessages={visibleWorkspace.conversation.recentMessages}
              onRefresh={async () => { await refreshWorkspace(); }}
              freshRequestsDisabled={planRequest.phase !== "idle"}
            />
          ) : null}
        </>
      ) : null}
    </AppShell>
  );
}
