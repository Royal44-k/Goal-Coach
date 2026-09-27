import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "@/core/errors/app-error";
import type { EvidenceType } from "@/core/domain/contracts";
import type { ModelRequest } from "@/server/agent/model-contracts";
import { GOAL_REVIEW_REQUEST_MESSAGE } from "@/lib/public-api-schemas";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import type { ModelClient, ModelTurn } from "@/server/agent/model-contracts";
import { createDatabase } from "@/server/db/client";
import { migrateDatabase } from "@/server/db/migrate";
import { loadServerEnv, type ServerEnv } from "@/server/config/env";
import { createRepositories } from "@/server/repositories/repository-factory";
import { PlanRevisionEnvelopeSchema, PlanRevisionPayloadSchema, TaskCreateInputSchema } from "@/server/repositories/revision-contracts";
import { LOCAL_OWNER_ID } from "@/server/security/local-owner";
import { createServiceContainer, type ServiceContainer } from "@/server/services/service-container";
import type { GoalWorkspace } from "@/server/services/service-contracts";
import { observeModelClient, type ProviderCall } from "./run";
import { lifecycleScenarios, type LifecycleScenario } from "./lifecycle-scenarios";
import { approvedReplanPreserved, pendingReplanPreserved, proposedUnfinishedDuesWithinDeadline, proposedUnfinishedWithinCapacity,
  proposedUnchangedWorkEstimatesPreserved, proposedRemainingWorkloadPreserved, capacityRefusalMatches, currentCapacityRefusalMatches, syntheticEvidence } from "./lifecycle-support";
import { diagnoseLifecyclePlanCall, type LifecyclePlanDiagnostic } from "./lifecycle-plan-diagnostics";

type ConstraintFeedback = { rule: string; capacity?: { estimatedRemainingMinutes: number; proposedUnfinishedMinutes: number } };
type LifecycleProviderCall = ProviderCall & {
  attemptOrdinal?: number;
  finishReason?: "stop" | "tool_calls" | "length" | "other";
  planDiagnostics?: LifecyclePlanDiagnostic[];
  constraintFeedback?: ConstraintFeedback[];
  toolCallCount?: number;
};

export type LifecycleOptions = {
  provider: "mock" | "deepseek"; allowLive: boolean; scenario: "learning" | "light_work" | "all";
  outputDir?: string; env?: ServerEnv; now?: Date; mockFailure?: "invalid_contract" | "unexplained_refusal";
  replanMode?: "standard" | "confirm-more-time" | "expect-capacity-conflict";
  mockEvidenceTypes?: readonly EvidenceType[];
  mockRequestObserver?: (request: ModelRequest) => void;
  mockTurnObserver?: (turn: { message: string; operationId: string }) => void;
  mockReadFailureAtStage?: string;
};
type Stage = {
  name: string; passed: boolean; durationMs: number; before: ReturnType<typeof snapshot> | null;
  after: ReturnType<typeof snapshot> | null; providerCalls: LifecycleProviderCall[];
  reply?: string; draft?: GoalWorkspace["pendingDrafts"][number];
  invariants?: Record<string, boolean>; exportCounts?: Record<string, number>;
  capacity?: { estimatedRemainingMinutes: number | null; proposedUnfinishedMinutes: number };
  capacityEvidence?: "rejected_proposal_tool_feedback" | "current_plan_no_tools";
  exportContent?: unknown;
  error?: { code: string; invariant?: string };
};
class LifecycleFailure extends Error {
  readonly code = "LIFECYCLE_INVARIANT";
  constructor(readonly invariant: string) { super(invariant); }
}
function insist(value: unknown, name: string): asserts value {
  if (!value) throw new LifecycleFailure(name);
}
function safeError(error: unknown) {
  return { code: error instanceof LifecycleFailure ? error.code : error instanceof AppError ? error.code : "UNEXPECTED_ERROR",
    ...(error instanceof LifecycleFailure ? { invariant: error.invariant } : {}) };
}
function snapshot(w: GoalWorkspace) {
  return {
    goalVersion: w.goal.version, agentState: w.goal.agentState, status: w.goal.status,
    formalContract: { desiredOutcome: w.goal.desiredOutcome, definitionOfDone: w.goal.definitionOfDone,
      deadline: w.goal.deadline, weeklyMinutes: w.goal.weeklyMinutes, constraints: w.goal.constraints,
      motivation: w.goal.motivation },
    currentPlanId: w.currentPlan?.id ?? null, currentPlanVersion: w.currentPlan?.version ?? null,
    taskCount: w.tasks.length, completedTasks: w.tasks.filter(t => t.status === "done").length,
    evidenceCount: w.evidence.length, pendingDraftKinds: w.pendingDrafts.map(d => d.kind),
    checkInCount: w.checkIns.length, reflectionSaved: w.reviewReflection !== null,
  };
}
function textTurn(text: string): ModelTurn {
  return { text, toolCalls: [], usage: { inputTokens: 12, outputTokens: 8 }, finishReason: "stop" };
}
function contractTurnMessage(scenario: LifecycleScenario) {
  return `${scenario.intake}\n${scenario.contractPrompt}`;
}
function timeChoiceMessage(scenario: LifecycleScenario) {
  return `我明确选择将每周可用时间恢复为 ${scenario.contract.weeklyMinutes} 分钟，已在界面记录。原期限、成果和验收标准不变；请把过大的起步任务拆成独立的15–30分钟行动并重排，不能只降低相同工作的估时。`;
}
function constraintFeedback(request: ModelRequest): ConstraintFeedback[] {
  const allowed = new Set(["completed_task_reset", "deadline_exceeded", "capacity_exceeded", "unchanged_work_estimate_reduced", "unfinished_workload_reduced"]);
  return request.messages.filter(message => message.role === "tool").flatMap(message => {
    try {
      const body = JSON.parse(message.content);
      return Array.isArray(body?.errors) ? body.errors.flatMap((item: { path?: unknown; rule?: unknown; expected?: unknown }) => {
        if (item?.path !== "payload.tasks" || typeof item.rule !== "string" || !allowed.has(item.rule)) return [];
        // Parse only the server's finite numeric suffix, never retain repair prose or task content.
        const match = typeof item.expected === "string" ? /Estimated remaining capacity: (\d+) minutes\. Proposed unfinished estimates: (\d+) minutes\.$/u.exec(item.expected) : null;
        const values = match ? [Number(match[1]), Number(match[2])] : [];
        return [{ rule: item.rule, ...(values.length === 2 && values.every(value => Number.isSafeInteger(value) && value >= 0)
          ? { capacity: { estimatedRemainingMinutes: values[0], proposedUnfinishedMinutes: values[1] } } : {}) }];
      }) : [];
    } catch { return []; }
  });
}
function syntheticClient(seed: { goalId: string; userMessage: string }, scenario: LifecycleScenario,
  workspace: () => Promise<GoalWorkspace>, failure?: LifecycleOptions["mockFailure"],
  evidenceTypes?: readonly EvidenceType[]): ModelClient {
  let pending = false;
  return { async complete(request) {
    if (pending) { pending = false; return textTurn("草案或建议已保存，请在界面核对。"); }
    const w = await workspace();
    const emit = (name: string, args: unknown): ModelTurn => {
      if (!request.tools.some(t => t.name === name)) return textTurn("当前阶段无法执行所需工具。");
      pending = true;
      return { text: "", toolCalls: [{ id: randomUUID(), name, argumentsJson: JSON.stringify(args) }],
        usage: { inputTokens: 25, outputTokens: 20 }, finishReason: "tool_calls" };
    };
    if (seed.userMessage === contractTurnMessage(scenario)) {
      if (failure === "invalid_contract") return textTurn("已准备好草案，请确认。");
      return emit("create_goal_contract_draft", {
        goalId: seed.goalId, expectedGoalVersion: w.goal.version, contract: scenario.contract, assumptions: [],
      });
    }
    if (seed.userMessage === scenario.planPrompt) {
      const tasks = scenario.tasks.map((t, index) => ({ ...t, id: randomUUID(), evidenceType: evidenceTypes?.[index] ?? "text",
        dueAt: null, dependencyIds: [] }));
      return emit("create_plan_draft", { goalId: seed.goalId,
        payload: { base: { goalVersion: w.goal.version, planVersionId: w.goal.currentPlanVersionId }, tasks,
          milestones: ["整理起步材料", "形成可见成果", "核对交付结果"], changeReason: null } });
    }
    if (seed.userMessage === scenario.blockerPrompt) {
      const check = w.effectiveCheckIns.findLast(c => c.kind === "blocker");
      return check?.blockerCategory ? emit("diagnose_blocker", { goalId: seed.goalId, taskId: check.taskId,
        blockerCategory: check.blockerCategory, note: check.note,
        advice: { minimumNextStep: "先用五分钟列出缺少的资料。", explanation: "根据已记录阻碍缩小下一步，不更改正式任务。" } })
        : textTurn("请先记录阻碍。");
    }
    if (seed.userMessage === scenario.replanPrompt || seed.userMessage === timeChoiceMessage(scenario)) {
      if (failure === "unexplained_refusal") return textTurn("目前无法生成草案。");
      const target = w.tasks.find(t => t.status !== "done");
      if (!target || !w.currentPlan) return textTurn("当前没有可调整任务。");
      const starterId = randomUUID();
      const tasks = w.tasks.flatMap(t => t.id === target.id ? [{ id: starterId,
        title: "核对一个合成样本的输入字段", action: "从一份合成样本列出后续任务需要的输入字段与预期结果。",
        doneCriteria: "一份合成样本的输入字段与预期结果形成可核对的检查表。", evidenceType: "text" as const,
        estimateMinutes: 20, dueAt: t.dueAt, dependencyIds: [...t.dependencyIds] },
        { ...TaskCreateInputSchema.strip().parse(t), dependencyIds: [starterId] }]
        : [TaskCreateInputSchema.strip().parse(t)]);
      return emit("propose_replan", { goalId: seed.goalId, payload: { base: { goalVersion: w.goal.version, planVersionId: w.goal.currentPlanVersionId }, tasks,
        milestones: w.currentPlan.milestones, changeReason: "依据已记录的任务过大阻碍，拆出一份合成样本的20分钟独立检查表；原任务工作和估时保留" } });
    }
    if (seed.userMessage === GOAL_REVIEW_REQUEST_MESSAGE)
      return textTurn(`目标复盘：当前计划 ${w.tasks.length} 项，已完成 ${w.tasks.filter(t => t.status === "done").length} 项，保存合成证据 ${w.evidence.length} 条。`);
    return textTurn("请核对当前目标。");
  } };
}
function executionInput(w: GoalWorkspace, task: GoalWorkspace["tasks"][number]) {
  insist(w.currentPlan, "current_plan_required");
  return { goalId: w.goal.id, expectedVersion: task.version, expectedGoalVersion: w.goal.version,
    expectedPlanVersion: { id: w.currentPlan.id, version: w.currentPlan.version },
    source: "ui_explicit" as const, operationId: randomUUID() };
}
function draftOf(w: GoalWorkspace, kind: "goal_contract" | "plan" | "replan") {
  const found = w.pendingDrafts.filter(d => d.kind === kind);
  insist(found.length === 1, `${kind}_draft_missing_or_duplicate`);
  return found[0];
}
async function runScenario(scenario: LifecycleScenario, options: LifecycleOptions, env: ServerEnv, now: Date) {
  const db = createDatabase(":memory:");
  const stages: Stage[] = [];
  let services: ServiceContainer;
  let goalId: string | null = null;
  let activeCalls: LifecycleProviderCall[] = [];
  const acceptanceScope = options.replanMode === "expect-capacity-conflict" ? "capacity_refusal_only"
    : options.replanMode === "confirm-more-time" ? "full_lifecycle_after_explicit_time_choice" : "full_lifecycle";
  const scenarioName = scenario.id + (options.replanMode === "expect-capacity-conflict" ? "_capacity_conflict"
    : options.replanMode === "confirm-more-time" ? "_user_chose_more_time" : "");
  const report = () => {
    const providerCalls = stages.flatMap(s => s.providerCalls.map(call => ({ ...call, stage: s.name })));
    const terminal = options.replanMode === "expect-capacity-conflict" ? "capacity_conflict_refusal" : "owner_export";
    return { scenario: scenarioName, provider: options.provider, acceptanceScope,
      passed: stages.at(-1)?.name === terminal && stages.at(-1)?.passed === true && stages.every(s => s.passed),
      stages, providerCalls,
      usage: { knownInputTokens: providerCalls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0),
        knownOutputTokens: providerCalls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0),
        unknownAttempts: providerCalls.filter(call => call.usage === null).length } };
  };
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    services = createServiceContainer({
      repositories, env, now: () => now,
      ...(options.provider === "mock" ? { mockClientFactory: (seed: { goalId: string; userMessage: string }) =>
        syntheticClient(seed, scenario, () => services.goals.getWorkspace(LOCAL_OWNER_ID, seed.goalId),
          options.mockFailure, options.mockEvidenceTypes) } : {}),
      modelClientDecorator: (client, metadata) => {
        insist(metadata.provider === options.provider, "provider_mismatch");
        const observed: ModelClient = options.provider === "mock" && options.mockRequestObserver
          ? { complete(request) { options.mockRequestObserver!(request); return client.complete(request); } }
          : client;
        const metered = observeModelClient(observed, activeCalls);
        return { async complete(request) {
          const planAvailable = request.tools.some(tool => tool.name === "create_plan_draft" || tool.name === "propose_replan");
          const workspaceBefore = planAvailable
            ? await services.goals.getWorkspace(LOCAL_OWNER_ID, metadata.seed.goalId).catch(() => null)
            : null;
          const response = await metered.complete(request);
          activeCalls.at(-1)!.toolCallCount = response.toolCalls.length;
          const feedback = constraintFeedback(request);
          if (feedback.length) activeCalls.at(-1)!.constraintFeedback = feedback;
          activeCalls.at(-1)!.finishReason = response.finishReason === "stop"
            || response.finishReason === "tool_calls" || response.finishReason === "length"
            ? response.finishReason : "other";
          try {
            const diagnostics = response.toolCalls.flatMap(call => {
              const value = diagnoseLifecyclePlanCall(call, workspaceBefore);
              return value ? [value] : [];
            });
            if (diagnostics.length) activeCalls.at(-1)!.planDiagnostics = diagnostics;
          } catch {
            // Diagnostics must never change the model response or tool execution.
          }
          return response;
        } };
      },
    });
    const current = () => goalId ? services.goals.getWorkspace(LOCAL_OWNER_ID, goalId) : Promise.resolve(null);
    async function stage(name: string, action: (before: GoalWorkspace | null) => Promise<Partial<Stage> | void>) {
      activeCalls = [];
      const started = performance.now();
      let before: GoalWorkspace | null = null;
      try {
        if (options.provider === "mock" && options.mockReadFailureAtStage === name)
          throw new LifecycleFailure("pre_stage_workspace_read");
        before = await current();
        const details = await action(before);
        const after = await current();
        stages.push({ name, passed: true, durationMs: performance.now() - started,
          before: before && snapshot(before), after: after && snapshot(after),
          providerCalls: activeCalls.map((call, index) => ({ ...call, attemptOrdinal: index + 1 })),
          ...(details ?? {}) });
      } catch (error) {
        const after = await current().catch(() => null);
        stages.push({ name, passed: false, durationMs: performance.now() - started,
          before: before && snapshot(before), after: after && snapshot(after),
          providerCalls: activeCalls.map((call, index) => ({ ...call, attemptOrdinal: index + 1 })),
          ...(after?.conversation.recentMessages.findLast(message => message.role === "assistant")
            ? { reply: after.conversation.recentMessages.findLast(message => message.role === "assistant")!.content } : {}),
          ...(after?.pendingDrafts.at(-1) ? { draft: after.pendingDrafts.at(-1)! } : {}),
          error: safeError(error) });
        throw error;
      }
    }
    const turn = (message: string, explicitIntent = false, operationId = randomUUID()) => {
      if (options.provider === "mock") options.mockTurnObserver?.({ message, operationId });
      return services.agent.processTurn(LOCAL_OWNER_ID, { goalId, message, explicitIntent, requestOperationId: operationId });
    };
    try {
      await stage("create", async () => {
        const made = await services.goals.create(LOCAL_OWNER_ID, { category: scenario.category, initialMessage: scenario.intake });
        goalId = made.goal.id;
      });
      await stage("consent", async () => {
        if (options.provider === "mock") return;
        const setting = await services.settings.get(LOCAL_OWNER_ID);
        const selected = setting.provider === "deepseek" ? setting : await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, provider: "deepseek" });
        await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: selected.version, privacyAccepted: true,
          privacyProvider: "deepseek", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
      });
      await stage("contract_draft", async before => {
        const op = randomUUID();
        const message = contractTurnMessage(scenario);
        const result = await turn(message, false, op);
        const after = await current();
        insist(before && after, "workspace_required");
        const draft = draftOf(after, "goal_contract");
        const formalGoalUnchanged = JSON.stringify(snapshot(before).formalContract) === JSON.stringify(snapshot(after).formalContract);
        insist(formalGoalUnchanged, "contract_draft_changed_formal_goal");
        const count = activeCalls.length;
        const replay = await turn(message, false, op);
        const replayProviderCallsUnchanged = activeCalls.length === count;
        insist(replayProviderCallsUnchanged && JSON.stringify(replay) === JSON.stringify(result), "contract_replay_dispatched_model");
        return { reply: result.message, draft, invariants: { formalGoalUnchanged, replayProviderCallsUnchanged } };
      });
      await stage("contract_approval", async before => {
        insist(before, "workspace_required");
        const draft = draftOf(before, "goal_contract");
        await services.approvals.approve(LOCAL_OWNER_ID, { goalId, draftId: draft.id, expectedDraftVersion: draft.version,
          toolName: "save_approved_contract", operationId: randomUUID() });
        const after = await current();
        insist(after?.goal.desiredOutcome && after.goal.definitionOfDone && after.goal.deadline && after.goal.weeklyMinutes, "approved_contract_incomplete");
      });
      await stage("plan_draft", async before => {
        const result = await turn(scenario.planPrompt);
        const after = await current();
        insist(before && after, "workspace_required");
        const draft = draftOf(after, "plan");
        const currentPlanUnchanged = before.currentPlan === null && after.currentPlan === null && after.tasks.length === 0;
        insist(currentPlanUnchanged, "plan_draft_mutated_current_plan");
        const capacity = proposedUnfinishedWithinCapacity(before, PlanRevisionPayloadSchema.parse(draft.payload), now);
        insist(capacity.withinCapacity, "plan_proposed_work_exceeds_remaining_capacity");
        return { reply: result.message, draft, invariants: { currentPlanUnchanged, withinCapacity: capacity.withinCapacity },
          capacity: { estimatedRemainingMinutes: capacity.estimatedRemainingMinutes, proposedUnfinishedMinutes: capacity.proposedUnfinishedMinutes } };
      });
      await stage("plan_approval", async before => {
        insist(before, "workspace_required");
        const draft = draftOf(before, "plan");
        await services.approvals.approve(LOCAL_OWNER_ID, { goalId, draftId: draft.id, expectedDraftVersion: draft.version,
          toolName: "save_approved_plan", operationId: randomUUID() });
        const after = await current();
        insist(after?.currentPlan && after.tasks.length >= 3, "approved_plan_missing");
      });
      await stage("execution_undo", async before => {
        insist(before, "workspace_required");
        const task = before.tasks[0];
        await services.tasks.update(LOCAL_OWNER_ID, task.id, { ...executionInput(before, task), status: "doing", actualMinutes: 5 }, "ui_explicit");
        const changed = await current();
        insist(changed?.tasks[0].status === "doing" && changed.undoCandidate, "execution_change_missing");
        await services.tasks.undo(LOCAL_OWNER_ID, goalId!, { operationId: randomUUID(),
          expectedUndoId: changed.undoCandidate.id, expectedGoalVersion: changed.goal.version });
        const undone = await current();
        insist(undone?.tasks[0].status === "todo" && undone.tasks[0].actualMinutes === null, "unified_undo_failed");
      });
      await stage("first_evidence", async before => {
        insist(before, "workspace_required");
        const task = before.tasks[0];
        await services.tasks.update(LOCAL_OWNER_ID, task.id, { ...executionInput(before, task), status: "done",
          actualMinutes: 25, evidence: syntheticEvidence(task) }, "ui_explicit");
        const after = await current();
        insist(after?.tasks[0].status === "done" && after.evidence.length === 1, "first_evidence_not_saved");
      });
      await stage("blocker_and_availability", async before => {
        insist(before, "workspace_required");
        await services.tasks.recordCheckIn(LOCAL_OWNER_ID, goalId!, { taskId: before.tasks[1].id, kind: "blocker",
          blockerCategory: "task_too_large", note: "合成阻碍：起步范围过大。", minutesSpent: null, availableWeeklyMinutes: null,
          expectedGoalVersion: before.goal.version, operationId: randomUUID() });
        const next = await current();
        insist(next, "workspace_required");
        await services.tasks.recordCheckIn(LOCAL_OWNER_ID, goalId!, { taskId: null, kind: "availability_change",
          blockerCategory: null, note: "合成可用时间变更。", minutesSpent: null,
          availableWeeklyMinutes: Math.max(30, Math.floor(scenario.contract.weeklyMinutes / 2)),
          expectedGoalVersion: next.goal.version, operationId: randomUUID() });
      });
      await stage("blocker_advice", async before => {
        const result = await turn(scenario.blockerPrompt);
        const after = await current();
        insist(before && after && result.advice && after.currentPlan?.id === before.currentPlan?.id, "blocker_advice_missing_or_mutating");
        return { reply: result.message, invariants: { currentPlanUnchanged: true } };
      });
      if (options.replanMode === "expect-capacity-conflict") {
        await stage("capacity_conflict_refusal", async before => {
          insist(before?.currentPlan, "workspace_required");
          const capacity = proposedUnfinishedWithinCapacity(before, { tasks: before.tasks, executionResets: [] }, now);
          insist(capacity.estimatedRemainingMinutes !== null && !capacity.withinCapacity, "baseline_capacity_conflict_required");
          const result = await turn(scenario.replanPrompt);
          const after = await current();
          insist(after, "workspace_required");
          const feedback = activeCalls.flatMap(call => call.constraintFeedback ?? []).findLast(item => item.rule === "capacity_exceeded" && item.capacity);
          const currentConflict = activeCalls.every(call => !call.constraintFeedback?.length)
            && (before.goal.agentState === "active" || before.goal.agentState === "replanning")
            && currentCapacityRefusalMatches(result.message, capacity, activeCalls.map(call => call.toolCallCount));
          const knownCapacityConstraint = Boolean(feedback?.capacity) || currentConflict;
          insist(knownCapacityConstraint, "known_capacity_constraint_required");
          const protectedState = (w: GoalWorkspace) => JSON.stringify({ goal: w.goal, plan: w.currentPlan,
            tasks: w.tasks, evidence: w.evidence, checkIns: w.checkIns, drafts: w.pendingDrafts });
          const formalAndExecutionUnchanged = protectedState(before) === protectedState(after);
          insist(formalAndExecutionUnchanged, "capacity_refusal_mutated_workspace");
          insist(after.pendingDrafts.length === 0 && !result.draftId, "capacity_refusal_saved_draft");
          insist(feedback?.capacity ? capacityRefusalMatches(result.message, feedback.capacity) : currentConflict,
            "capacity_refusal_reply_mismatch");
          return { reply: result.message, capacity: { estimatedRemainingMinutes: capacity.estimatedRemainingMinutes,
            proposedUnfinishedMinutes: capacity.proposedUnfinishedMinutes },
          capacityEvidence: feedback?.capacity ? "rejected_proposal_tool_feedback" : "current_plan_no_tools",
          invariants: { formalAndExecutionUnchanged, knownCapacityConstraint, noPendingDraft: true } };
        });
        return report();
      }
      if (options.replanMode === "confirm-more-time") {
        await stage("explicit_user_time_choice", async before => {
          insist(before, "workspace_required");
          await services.tasks.recordCheckIn(LOCAL_OWNER_ID, goalId!, { taskId: null, kind: "availability_change",
            blockerCategory: null, note: `合成用户明确选择恢复每周 ${scenario.contract.weeklyMinutes} 分钟，保留原期限和验收标准。`,
            minutesSpent: null, availableWeeklyMinutes: scenario.contract.weeklyMinutes,
            expectedGoalVersion: before.goal.version, operationId: randomUUID() });
          const after = await current();
          insist(after, "workspace_required");
          const formalCommitmentsUnchanged = JSON.stringify(snapshot(before).formalContract) === JSON.stringify(snapshot(after).formalContract);
          const executionUnchanged = pendingReplanPreserved(before, after);
          const availabilityRecorded = after.checkIns.length === before.checkIns.length + 1
            && after.checkIns.at(-1)?.availableWeeklyMinutes === scenario.contract.weeklyMinutes;
          insist(formalCommitmentsUnchanged && executionUnchanged && availabilityRecorded, "explicit_time_choice_changed_other_state");
          return { invariants: { formalCommitmentsUnchanged, executionUnchanged, availabilityRecorded } };
        });
      }
      await stage("replan_draft", async before => {
        const result = await turn(options.replanMode === "confirm-more-time" ? timeChoiceMessage(scenario) : scenario.replanPrompt);
        const after = await current();
        insist(before && after, "workspace_required");
        const draft = draftOf(after, "replan");
        const completedEvidencePreserved = pendingReplanPreserved(before, after);
        insist(completedEvidencePreserved, "replan_draft_changed_execution");
        const payload = PlanRevisionPayloadSchema.parse(draft.payload);
        const unfinishedDuesWithinDeadline = proposedUnfinishedDuesWithinDeadline(before, payload);
        insist(unfinishedDuesWithinDeadline, "replan_proposed_due_after_contract_deadline");
        const unchangedWorkEstimatesPreserved = proposedUnchangedWorkEstimatesPreserved(before, payload);
        insist(unchangedWorkEstimatesPreserved, "replan_unchanged_work_underestimated");
        const remainingWorkloadPreserved = proposedRemainingWorkloadPreserved(before, payload);
        insist(remainingWorkloadPreserved, "replan_total_unfinished_workload_reduced");
        const capacity = proposedUnfinishedWithinCapacity(before, payload, now);
        insist(capacity.withinCapacity, "replan_proposed_work_exceeds_remaining_capacity");
        return { reply: result.message, draft, invariants: { completedEvidencePreserved, unfinishedDuesWithinDeadline,
          unchangedWorkEstimatesPreserved, remainingWorkloadPreserved,
          withinCapacity: capacity.withinCapacity },
          capacity: { estimatedRemainingMinutes: capacity.estimatedRemainingMinutes, proposedUnfinishedMinutes: capacity.proposedUnfinishedMinutes } };
      });
      await stage("replan_approval", async before => {
        insist(before, "workspace_required");
        const draft = draftOf(before, "replan");
        await services.approvals.approve(LOCAL_OWNER_ID, { goalId, draftId: draft.id,
          expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() });
        const after = await current();
        insist(after?.currentPlan, "approved_replan_missing");
        const revision = PlanRevisionEnvelopeSchema.parse(after.currentPlan.diff).revision;
        insist(approvedReplanPreserved(before, after, revision), "approved_replan_lost_evidence");
      });
      await stage("remaining_evidence", async () => {
        for (;;) {
          const w = await current();
          insist(w, "workspace_required");
          const task = w.tasks.find(t => t.status !== "done");
          if (!task) break;
          await services.tasks.update(LOCAL_OWNER_ID, task.id, { ...executionInput(w, task), status: "done",
            actualMinutes: Math.min(task.estimateMinutes, 30), evidence: syntheticEvidence(task) }, "ui_explicit");
        }
      });
      await stage("review", async () => {
        const result = await turn(GOAL_REVIEW_REQUEST_MESSAGE, true);
        const after = await current();
        insist(after?.reviewReflection?.message === result.message, "reflection_not_saved");
        return { reply: result.message };
      });
      await stage("completion", async before => {
        insist(before, "workspace_required");
        await services.goals.changeStatus(LOCAL_OWNER_ID, goalId!, { status: "completed",
          expectedVersion: before.goal.version, operationId: randomUUID() });
        const after = await current();
        insist(after?.goal.status === "completed", "trusted_completion_failed");
      });
      await stage("owner_export", async before => {
        insist(before?.currentPlan && before.reviewReflection, "terminal_workspace_incomplete");
        const exported = await services.data.export(LOCAL_OWNER_ID);
        const sameRows = <T extends { id: string }>(expected: T[], actual: T[]) =>
          expected.every(row => actual.some(saved => saved.id === row.id && JSON.stringify(saved) === JSON.stringify(row)));
        insist(exported.goals.length === 1 && exported.goals[0].id === before.goal.id
          && exported.goals[0].status === "completed"
          && sameRows(before.tasks, exported.tasks)
          && sameRows(before.evidence, exported.evidence)
          && sameRows(before.checkIns, exported.checkIns)
          && exported.planVersions.length === 2
          && exported.planVersions.some(plan => plan.id === before.currentPlan!.id
            && JSON.stringify(plan.diff) === JSON.stringify(before.currentPlan!.diff))
          && exported.conversationMessages.some(message => message.content === before.reviewReflection!.message),
          "owner_export_incomplete");
        return { exportCounts: { goals: exported.goals.length, tasks: exported.tasks.length,
          evidence: exported.evidence.length, plans: exported.planVersions.length, checkIns: exported.checkIns.length },
          exportContent: { goal: before.goal, currentPlan: before.currentPlan, tasks: before.tasks,
            evidence: before.evidence, checkIns: before.checkIns, reflection: before.reviewReflection } };
      });
    } catch { /* Failure was captured by the stage; dependent stages stop. */ }
    return report();
  } finally { db.$client.close(); }
}
export function parseLifecycleArgs(argv: string[]): Pick<LifecycleOptions, "provider" | "allowLive" | "scenario" | "replanMode"> {
  let provider: LifecycleOptions["provider"] = "mock", scenario: LifecycleOptions["scenario"] = "all", allowLive = false;
  let replanMode: LifecycleOptions["replanMode"];
  const seen = new Set<string>();
  for (const arg of argv) {
    const match = /^(--provider|--scenario|--replan-mode)=(.+)$/u.exec(arg);
    const key = match?.[1] ?? arg;
    if (seen.has(key)) throw new Error(`Duplicate lifecycle argument: ${key}`);
    seen.add(key);
    if (key === "--provider" && (match?.[2] === "mock" || match?.[2] === "deepseek")) provider = match[2];
    else if (key === "--scenario" && (match?.[2] === "learning" || match?.[2] === "light_work" || match?.[2] === "all")) scenario = match[2];
    else if (key === "--allow-live") allowLive = true;
    else if (key === "--replan-mode" && (match?.[2] === "standard" || match?.[2] === "confirm-more-time" || match?.[2] === "expect-capacity-conflict")) replanMode = match[2];
    else throw new Error(`Unknown lifecycle argument: ${arg}`);
  }
  if (provider === "deepseek" && !allowLive) throw new Error("Live evaluation requires --provider=deepseek --allow-live");
  if ((replanMode === "confirm-more-time" && scenario === "all") || (replanMode === "expect-capacity-conflict" && scenario !== "learning"))
    throw new Error("Select learning or light_work for a time choice; capacity refusal requires learning");
  return { provider, scenario, allowLive, ...(replanMode ? { replanMode } : {}) };
}
export async function runLifecycleEvaluation(options: LifecycleOptions) {
  if (options.provider === "deepseek" && !options.allowLive) throw new Error("Live evaluation requires --allow-live");
  if (options.mockFailure && options.provider !== "mock") throw new Error("Mock failure injection requires mock provider");
  if ((options.replanMode === "confirm-more-time" && options.scenario === "all") || (options.replanMode === "expect-capacity-conflict" && options.scenario !== "learning"))
    throw new Error("Select learning or light_work for a time choice; capacity refusal requires learning");
  const env = options.env ?? (options.provider === "mock" ? loadServerEnv({}) : null);
  if (!env) throw new Error("Live evaluation requires explicitly loaded ServerEnv");
  if (env.provider !== options.provider) throw new Error("Evaluation provider does not match ServerEnv");
  const now = options.now ?? new Date();
  const selected = lifecycleScenarios(now).filter(s => options.scenario === "all" || s.id === options.scenario);
  const outputDir = resolve(options.outputDir ?? `evals/results/lifecycle-${options.provider}-${now.toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`);
  mkdirSync(outputDir, { recursive: true });
  const results = [], resultFiles: string[] = [];
  for (const scenario of selected) {
    const fixture = options.provider === "mock" && options.replanMode === "expect-capacity-conflict"
      ? { ...scenario, tasks: scenario.tasks.map((task, index) => ({ ...task, estimateMinutes: index === 0 ? 180 : 330 })) } : scenario;
    const result = await runScenario(fixture, options, env, now);
    const path = resolve(outputDir, `${result.scenario}.json`);
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    results.push(result); resultFiles.push(path);
  }
  return { provider: options.provider, totalScenarios: results.length, passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length, resultFiles,
    providerCalls: results.reduce((sum, r) => sum + r.providerCalls.length, 0),
    knownInputTokens: results.reduce((sum, r) => sum + r.usage.knownInputTokens, 0),
    knownOutputTokens: results.reduce((sum, r) => sum + r.usage.knownOutputTokens, 0),
    unknownUsageAttempts: results.reduce((sum, r) => sum + r.usage.unknownAttempts, 0) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseLifecycleArgs(process.argv.slice(2));
    const env = options.provider === "deepseek"
      ? (process.loadEnvFile(resolve(".env.local")), loadServerEnv({ ...process.env, MODEL_PROVIDER: "deepseek" })) : loadServerEnv({});
    const summary = await runLifecycleEvaluation({ ...options, env });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof AppError ? error.code : error instanceof Error ? error.message : "Lifecycle evaluation failed");
    process.exitCode = 1;
  }
}
