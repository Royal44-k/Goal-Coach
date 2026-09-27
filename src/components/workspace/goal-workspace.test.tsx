// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GoalWorkspace as GoalWorkspaceData } from "@/lib/public-api-schemas";
import { GoalWorkspace } from "./goal-workspace";
import { useRecoverableWorkspaceMutation } from "./use-recoverable-workspace-mutation";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

const now = "2026-09-16T08:00:00+08:00";
const ownerId = "43000000-0000-4000-8000-000000000099";
const goalId = "43000000-0000-4000-8000-000000000001";
const planId = "43000000-0000-4000-8000-000000000002";
const settings = {
  id: "43000000-0000-4000-8000-000000000090", createdAt: now, updatedAt: now, version: 2,
  privacyAcceptedAt: now, privacyProvider: "mock", privacyPolicyVersion: "2026-09-24", provider: "mock", model: "qwen3.7-flash-2026-07-15", fallbackEnabled: false,
  dailyInputTokenLimit: 100000, dailyOutputTokenLimit: 30000, apiKeyConfigured: false,
};
const baseGoal = {
  id: goalId, ownerId, createdAt: now, updatedAt: now, version: 5, title: "TypeScript 待办网页",
  category: "learning", status: "active", agentState: "active", clarificationCount: 1,
  currentPlanVersionId: planId, desiredOutcome: "完成待办网页", definitionOfDone: "刷新后仍保留记录",
  deadline: "2026-10-14", weeklyMinutes: 420, constraints: [], motivation: "掌握类型系统",
};
const payload = {
  schemaVersion: 2, milestones: ["掌握基础类型", "完成网页交互", "验证数据保留"],
  base: { planVersionId: null, goalVersion: 4 }, changeReason: null, changeSource: "agent",
  tasks: [], executionResets: [], diff: { added: [], removed: [], moved: [], changed: [] },
};
const currentPlan = {
  id: planId, ownerId, goalId, number: 1, status: "approved", changeReason: null, changeSource: "agent",
  diff: { added: [], removed: [], moved: [], changed: [], revision: {
    schemaVersion: 2, draftArtifactId: "43000000-0000-4000-8000-000000000003", draftArtifactVersion: 1,
    payload, taskMap: [], evidenceMap: [],
  } },
  approvedAt: now, createdAt: now, updatedAt: now, version: 1,
  milestones: payload.milestones,
};
const executionTask = {
  id: "43000000-0000-4000-8000-000000000110", ownerId, goalId, planVersionId: planId,
  title: "实现执行工作台", action: "连接正式任务状态和可撤销修改", doneCriteria: "完成后进度来自正式接口",
  evidenceType: "text" as const, estimateMinutes: 30, actualMinutes: null, dueAt: "2026-09-18",
  dependencyIds: [], status: "todo" as const, createdAt: now, updatedAt: now, version: 2,
};

function blockerCheckIn(version = 1) {
  return {
    id: "43000000-0000-4000-8000-000000000210", ownerId, goalId, taskId: executionTask.id,
    kind: "blocker" as const, blockerCategory: "insufficient_time" as const, note: "只有二十分钟",
    minutesSpent: null, availableWeeklyMinutes: null, withdrawnAt: null, createdAt: now, updatedAt: now, version,
  };
}

const blockerAdviceResult = {
  message: "先把起点缩小。", state: "active" as const, persistedChange: false,
  adviceGoalVersion: 5,
  advice: {
    minimumNextStep: "先用 5 分钟列出一个最小步骤",
    explanation: "当前可用时间较短，先保留最小进展。",
    taskId: executionTask.id,
    blockerCategory: "insufficient_time" as const,
  },
  usage: { inputTokens: 12, outputTokens: 8, modelCalls: 1, toolCalls: 1 },
};

function executionWorkspace(overrides: Record<string, unknown> = {}) {
  return workspace({
    tasks: [executionTask],
    progress: { completed: 0, total: 1, percent: 0 },
    nextAction: { task: executionTask, suggestedSliceMinutes: 30, reasons: ["按30分钟起步窗口推荐"] },
    ...overrides,
  });
}

function pendingReplan(tasks = [executionTask]) {
  const proposed = tasks.map(task => ({
    id: task.id, title: task.title, action: task.action, doneCriteria: task.doneCriteria,
    evidenceType: task.evidenceType, estimateMinutes: task.estimateMinutes, dueAt: task.dueAt,
    dependencyIds: task.dependencyIds,
  }));
  return {
    id: "43000000-0000-4000-8000-000000000130", ownerId, goalId, kind: "replan" as const, status: "pending" as const,
    contentHash: "7".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: {
      schemaVersion: 2 as const, milestones: currentPlan.milestones, base: { planVersionId: planId, goalVersion: 5 },
      changeReason: "手动调整", changeSource: "user" as const, tasks: proposed, executionResets: [],
      diff: { added: [], removed: [], moved: [], changed: proposed.map(task => task.id) },
    },
  };
}
function workspace(overrides: Record<string, unknown> = {}) {
  const historicalPlan: Record<string, unknown> = { ...currentPlan };
  delete historicalPlan.milestones;
  return {
    canUndo: false, undoCandidate: null, undoUnavailableReason: null, effectiveCheckIns: overrides.checkIns ?? [], goal: baseGoal, currentPlan, tasks: [], evidence: [], checkIns: [], pendingDrafts: [],
    planHistory: [historicalPlan], conversation: { summary: null, recentMessages: [] }, reviewReflection: null, preference: null,
    progress: { completed: 0, total: 0, percent: 0 }, nextAction: null, replanTriggers: [], ...overrides,
  };
}
function summary(goal: { id: string; title: string; category: string; status: string; agentState: string; updatedAt: string } = baseGoal) {
  return { id: goal.id, title: goal.title, category: goal.category, status: goal.status, agentState: goal.agentState,
    updatedAt: goal.updatedAt, progress: { completed: 0, total: 0, percent: 0 } };
}
function installFetch(data: ReturnType<typeof workspace>) {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(data.goal as typeof baseGoal)] }));
    if (url === `/api/goals/${goalId}`) return Promise.resolve(Response.json({ ok: true, data }));
    throw new Error(`Unexpected ${url}`);
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.replace.mockReset();
});

it("keeps approved tasks usable with expired invite consent without dispatching a model request", async () => {
  const user = userEvent.setup();
  const expired = { ...settings, provider: "deepseek", model: "deepseek-flash", privacyAcceptedAt: null, privacyProvider: null };
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: expired }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary()] }));
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: executionWorkspace() }));
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH") {
      return Promise.resolve(Response.json({ ok: true, data: { ...executionTask, status: "doing", version: 3 } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);
  await user.click(await screen.findByRole("button", { name: "开始这个任务" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/tasks/${executionTask.id}`))).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
});

it("leaves an unknown deleted-goal workspace only after an exact authoritative absence read", async () => {
  const identity = { goalId, generation: 1 };
  const publish = vi.fn();
  const reader = vi.fn().mockResolvedValue({ kind: "goal_absent" as const, goalId, publish });
  const fetchMock = vi.fn().mockRejectedValue(new TypeError("delete response lost"));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useRecoverableWorkspaceMutation({
    goalId,
    currentIdentity: () => identity,
    isCurrent: candidate => candidate.goalId === goalId && candidate.generation === 1,
    refreshWorkspace: vi.fn(),
  }));

  act(() => {
    expect(result.current.startFreshMutation("goal_delete", () => ({
      label: "目标删除",
      path: `/api/goals/${goalId}`,
      method: "DELETE",
      body: { operationId: "43000000-0000-4000-8000-000000000250" },
      schema: z.null(),
      readAuthoritativeState: reader,
    }))).toBe(true);
  });
  await waitFor(() => expect(result.current.state.phase).toBe("unknown"));
  await act(async () => { await result.current.refreshUnknownMutation(); });

  expect(reader).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledOnce();
  expect(result.current.state.phase).toBe("idle");
  expect(result.current.blocked).toBe(false);
});

it("keeps a known successful delete GET-only while the exact goal is still present", async () => {
  const identity = { goalId, generation: 1 };
  const authoritative = executionWorkspace() as unknown as GoalWorkspaceData;
  const reader = vi.fn().mockResolvedValue({ kind: "workspace" as const, workspace: authoritative });
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: null }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useRecoverableWorkspaceMutation({
    goalId,
    currentIdentity: () => identity,
    isCurrent: candidate => candidate.goalId === goalId && candidate.generation === 1,
    refreshWorkspace: vi.fn(),
  }));

  act(() => {
    result.current.startFreshMutation("goal_delete", () => ({
      label: "目标删除", path: `/api/goals/${goalId}`, method: "DELETE",
      body: { operationId: "43000000-0000-4000-8000-000000000251" }, schema: z.null(), readAuthoritativeState: reader,
    }));
  });
  await waitFor(() => expect(result.current.state.phase).toBe("success_refresh_failed"));
  await act(async () => { await result.current.reconcileMutation(); });
  expect(result.current.state.phase).toBe("success_refresh_failed");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(reader).toHaveBeenCalledTimes(2);
  expect(result.current.blocked).toBe(true);
});

it("releases a received delete failure when a later authoritative read finds the goal present", async () => {
  const identity = { goalId, generation: 1 };
  const authoritative = executionWorkspace() as unknown as GoalWorkspaceData;
  const reader = vi.fn()
    .mockRejectedValueOnce(new TypeError("authoritative read lost"))
    .mockResolvedValue({ kind: "workspace" as const, workspace: authoritative });
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "VERSION_CONFLICT", message: "stale" },
  }, { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useRecoverableWorkspaceMutation({
    goalId,
    currentIdentity: () => identity,
    isCurrent: candidate => candidate.goalId === goalId && candidate.generation === 1,
    refreshWorkspace: vi.fn(),
  }));

  act(() => {
    expect(result.current.startFreshMutation("goal_delete", () => ({
      label: "目标删除", path: `/api/goals/${goalId}`, method: "DELETE",
      body: { operationId: "43000000-0000-4000-8000-000000000253" }, schema: z.null(), readAuthoritativeState: reader,
    }))).toBe(true);
  });
  await waitFor(() => expect(result.current.state.phase).toBe("refresh_failed"));
  expect(result.current.state.receivedErrorCode).toBe("VERSION_CONFLICT");

  await act(async () => { await result.current.reconcileMutation(); });

  expect(result.current.state.phase).toBe("received_reconciled");
  expect(result.current.state.receivedErrorCode).toBe("VERSION_CONFLICT");
  expect(result.current.blocked).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(reader).toHaveBeenCalledTimes(2);
  act(() => {
    const freshLease = result.current.tryAcquireFreshMutation("execution");
    expect(freshLease).not.toBeNull();
    if (freshLease) expect(result.current.releaseFreshMutation(freshLease)).toBe(true);
  });
});

it.each(["skipped", "empty", "foreign-plan"])("does not show review for %s execution even with saved reflection and 100 percent display", async kind => {
  const doneTask = { ...executionTask, status: "done" as const };
  const current = executionWorkspace({
    goal: { ...baseGoal, agentState: "reviewing" },
    tasks: kind === "empty" ? [] : kind === "skipped" ? [doneTask, { ...doneTask, id: "43000000-0000-4000-8000-000000000111", status: "skipped" }] : [{ ...doneTask, planVersionId: "43000000-0000-4000-8000-000000000112" }],
    progress: { completed: 1, total: 1, percent: 100 }, nextAction: null,
    reviewReflection: { message: "历史复盘", generatedAt: now },
  });
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary()] }));
    if (url === `/api/goals/${goalId}`) return Promise.resolve(Response.json({ ok: true, data: current }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);
  await screen.findByRole("heading", { name: "当前已批准计划" });
  expect(screen.queryByRole("heading", { name: "核对当前执行记录" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
});

it("requests reflection only explicitly and completes the confirmed displayed goal version", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000252";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const doneTask = { ...executionTask, status: "done" as const, actualMinutes: 45, version: 3 };
  const reviewingGoal = { ...baseGoal, agentState: "reviewing" as const };
  const completedGoal = { ...reviewingGoal, status: "completed" as const, agentState: "completed" as const, version: 6 };
  const reflection = { message: "已完成 1 项，最小步骤有效。", generatedAt: now };
  const reviewWorkspace = executionWorkspace({
    goal: reviewingGoal, tasks: [doneTask], progress: { completed: 1, total: 1, percent: 100 }, nextAction: null,
    checkIns: [blockerCheckIn()], preference: { id: "43000000-0000-4000-8000-000000000260", ownerId, taskGranularity: "medium", preferredTimeWindow: null, estimateBias: 1.5, commonBlockers: ["insufficient_time"], effectiveStrategies: ["先做最小步骤"], createdAt: now, updatedAt: now, version: 2 },
    reviewReflection: reflection,
  });
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewingGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? reviewWorkspace : { ...reviewWorkspace, goal: completedGoal } }));
    }
    if (url === `/api/goals/${goalId}` && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: completedGoal }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByText("预计 30 分钟；已记录实际 45 分钟")).toBeInTheDocument();
  expect(screen.getByText("时间不足")).toBeInTheDocument();
  expect(screen.getByText("先做最小步骤")).toBeInTheDocument();
  expect(screen.getByText("第 1 版：初始计划")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除目标" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: /确认已核对当前执行数据/ }));
  await user.click(screen.getByRole("button", { name: "确认完成目标（目标 5）" }));
  expect(await screen.findByRole("button", { name: "删除目标" })).toBeInTheDocument();
  const body = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}` && init?.method === "PATCH")?.[1]?.body));
  expect(body).toEqual({ status: "completed", expectedVersion: 5, operationId });
});

it("invalidates a checked review when explicit regeneration refreshes the displayed goal snapshot", async () => {
  const user = userEvent.setup();
  const requestOperationId = "43000000-0000-4000-8000-000000000254";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(requestOperationId);
  const doneTask = { ...executionTask, status: "done" as const, actualMinutes: 45, version: 3 };
  const reviewingGoal = { ...baseGoal, agentState: "reviewing" as const };
  const initial = executionWorkspace({
    goal: reviewingGoal, tasks: [doneTask], progress: { completed: 1, total: 1, percent: 100 }, nextAction: null,
    reviewReflection: { message: "旧复盘", generatedAt: now },
  });
  const refreshed = executionWorkspace({
    goal: { ...reviewingGoal, version: 6 }, tasks: [{ ...doneTask, actualMinutes: 50, version: 4 }],
    progress: { completed: 1, total: 1, percent: 100 }, nextAction: null,
    reviewReflection: { message: "新复盘", generatedAt: "2026-09-16T09:00:00+08:00" },
  });
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewingGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? initial : refreshed }));
    }
    if (url === "/api/agent/turn") return Promise.resolve(Response.json({ ok: true, data: {
      message: "新复盘", state: "reviewing", persistedChange: false,
      usage: { inputTokens: 12, outputTokens: 8, modelCalls: 1, toolCalls: 0 },
    } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("checkbox", { name: /确认已核对当前执行数据/ }));
  expect(screen.getByRole("button", { name: "确认完成目标（目标 5）" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "重新生成目标复盘" }));
  expect(await screen.findByText("预计 30 分钟；已记录实际 50 分钟")).toBeInTheDocument();
  expect(screen.getByText("新复盘")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认完成目标（目标 6）" })).toBeDisabled();
  const body = JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === "/api/agent/turn")?.[1]?.body));
  expect(body).toEqual({ goalId, message: "请根据已记录的执行情况生成目标复盘。", requestOperationId, explicitIntent: true });
});

it("deletes a goal through the shared lease and navigates only after authoritative list absence", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("43000000-0000-4000-8000-000000000253");
  let listReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") { listReads += 1; return Promise.resolve(Response.json({ ok: true, data: listReads === 1 ? [summary(baseGoal)] : [] })); }
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: executionWorkspace() }));
    if (url === `/api/goals/${goalId}` && init?.method === "DELETE") return Promise.resolve(Response.json({ ok: true, data: null }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "删除目标" }));
  await user.type(screen.getByLabelText("输入目标标题确认删除"), baseGoal.title);
  await user.click(screen.getByRole("button", { name: "确认删除目标（目标 5）" }));
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
  expect(listReads).toBe(2);
  expect(fetchMock.mock.calls.filter(([url]) => url === `/api/goals/${goalId}`)).toHaveLength(2);
  const body = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}` && init?.method === "DELETE")?.[1]?.body));
  expect(body).toEqual({ source: "ui_confirmation", confirmationPhrase: baseGoal.title, expectedGoalVersion: 5, operationId: "43000000-0000-4000-8000-000000000253" });
});

it("atomically hands a confirmed continuation lease to its deferred consumer", async () => {
  const identity = { goalId, generation: 1 };
  const authoritative = executionWorkspace() as unknown as GoalWorkspaceData;
  const refreshWorkspace = vi.fn()
    .mockRejectedValueOnce(new TypeError("refresh interrupted"))
    .mockResolvedValue(authoritative);
  let handedLease: Parameters<ReturnType<typeof useRecoverableWorkspaceMutation>["releaseFreshMutation"]>[0] | null = null;
  const onConfirmed = vi.fn((lease: NonNullable<typeof handedLease>) => {
    handedLease = lease;
    return true;
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: null })));
  const { result } = renderHook(() => useRecoverableWorkspaceMutation({
    goalId,
    currentIdentity: () => identity,
    isCurrent: candidate => candidate.goalId === goalId && candidate.generation === 1,
    refreshWorkspace,
  }));

  act(() => {
    expect(result.current.startFreshMutation("blocker", () => ({
      label: "阻碍记录",
      path: `/api/goals/${goalId}/check-ins`,
      method: "POST",
      body: { operationId: "43000000-0000-4000-8000-000000000230" },
      schema: z.null(),
      continuationLabel: "继续分析",
      onConfirmed,
    }))).toBe(true);
  });
  await waitFor(() => expect(result.current.state.phase).toBe("success_refresh_failed"));
  await act(async () => { await result.current.reconcileMutation(); });
  expect(result.current.state.phase).toBe("confirmed_needs_continuation");
  const staleDecline = result.current.cancelConfirmedContinuation;

  act(() => {
    expect(result.current.continueConfirmedMutation()).toBe(true);
    expect(staleDecline()).toBe(false);
  });

  expect(onConfirmed).toHaveBeenCalledOnce();
  expect(handedLease).not.toBeNull();
  expect(result.current.blocked).toBe(true);
  expect(result.current.tryAcquireFreshMutation("execution")).toBeNull();
});

it("atomically declines a confirmed continuation before a stale continue handler can run", async () => {
  const identity = { goalId, generation: 1 };
  const authoritative = executionWorkspace() as unknown as GoalWorkspaceData;
  const refreshWorkspace = vi.fn()
    .mockRejectedValueOnce(new TypeError("refresh interrupted"))
    .mockResolvedValue(authoritative);
  const onConfirmed = vi.fn(() => true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: null })));
  const { result } = renderHook(() => useRecoverableWorkspaceMutation({
    goalId,
    currentIdentity: () => identity,
    isCurrent: candidate => candidate.goalId === goalId && candidate.generation === 1,
    refreshWorkspace,
  }));

  act(() => {
    result.current.startFreshMutation("blocker", () => ({
      label: "阻碍记录",
      path: `/api/goals/${goalId}/check-ins`,
      method: "POST",
      body: { operationId: "43000000-0000-4000-8000-000000000231" },
      schema: z.null(),
      continuationLabel: "继续分析",
      onConfirmed,
    }));
  });
  await waitFor(() => expect(result.current.state.phase).toBe("success_refresh_failed"));
  await act(async () => { await result.current.reconcileMutation(); });
  const staleContinue = result.current.continueConfirmedMutation;

  act(() => {
    expect(result.current.cancelConfirmedContinuation()).toBe(true);
    expect(staleContinue()).toBe(false);
  });

  expect(onConfirmed).not.toHaveBeenCalled();
  expect(result.current.blocked).toBe(false);
  expect(result.current.tryAcquireFreshMutation("execution")).not.toBeNull();
});

it("renders formal active state and the persisted approved milestones after reload", async () => {
  installFetch(workspace());
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByRole("heading", { name: baseGoal.title })).toBeInTheDocument();
  expect(screen.getByText("进行中")).toBeInTheDocument();
  const milestones = screen.getByRole("list", { name: "当前计划里程碑" });
  expect(milestones).toHaveTextContent("掌握基础类型");
  expect(milestones).toHaveTextContent("验证数据保留");
  expect(screen.getByRole("button", { name: "暂停目标" })).toBeEnabled();
});

it("reopens the current saved contract review rather than a historical id", async () => {
  const reviewGoal = { ...baseGoal, status: "draft", agentState: "contract_review", currentPlanVersionId: null,
    desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
  const draft = {
    id: "43000000-0000-4000-8000-000000000010", ownerId, goalId, kind: "goal_contract", status: "pending",
    contentHash: "c".repeat(64), createdAt: now, updatedAt: now, version: 4,
    payload: { schemaVersion: 2, baseGoalVersion: 5, contract: {
      title: reviewGoal.title, category: "learning", desiredOutcome: "完成待办网页",
      definitionOfDone: "刷新后仍保留记录", deadline: "2026-10-14", weeklyMinutes: 420,
      constraints: [], motivation: "掌握类型系统",
    }, assumptions: [] },
  };
  installFetch(workspace({ goal: reviewGoal, currentPlan: null, planHistory: [], pendingDrafts: [draft] }));
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByText("草案版本 4 · 目标版本 5")).toBeInTheDocument();
  expect(screen.getByText("完成待办网页")).toBeInTheDocument();
});

it("offers manual contract entry for an unsupported clarifying goal without calling the agent", async () => {
  const clarifying = { ...baseGoal, status: "draft", agentState: "clarifying", currentPlanVersionId: null,
    desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
  installFetch(workspace({ goal: clarifying, currentPlan: null, planHistory: [], pendingDrafts: [] }));
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByRole("button", { name: "手动填写目标" })).toBeEnabled();
  expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
});

it("keeps an uncertain agent request and unsent edits mounted across workspace refresh", async () => {
  const user = userEvent.setup();
  const clarifying = { ...baseGoal, status: "draft", agentState: "clarifying", currentPlanVersionId: null,
    desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
  const current = workspace({ goal: clarifying, currentPlan: null, planHistory: [], pendingDrafts: [] });
  const operationId = "43000000-0000-4000-8000-000000000080";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  let turnCount = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(clarifying)] }));
    if (url === `/api/goals/${goalId}`) return Promise.resolve(Response.json({ ok: true, data: current }));
    if (url === "/api/agent/turn") {
      turnCount += 1;
      if (turnCount === 1) return Promise.reject(new TypeError("lost response"));
      return Promise.resolve(Response.json({ ok: true, data: {
        message: "继续澄清", state: "clarifying", persistedChange: false,
        usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 },
      } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  const composer = await screen.findByLabelText("告诉教练你的目标");
  await user.type(composer, "原始请求");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "查询本次结果" });
  await user.clear(composer);
  await user.type(composer, "尚未发送的新文字");
  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));

  expect(screen.getByLabelText("告诉教练你的目标")).toHaveValue("尚未发送的新文字");
  await user.click(screen.getByRole("button", { name: "查询本次结果" }));
  const turnBodies = fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn").map(([, init]) => JSON.parse(String(init?.body)));
  expect(turnBodies).toEqual([
    { goalId, message: "原始请求", requestOperationId: operationId, explicitIntent: true },
    { goalId, message: "原始请求", requestOperationId: operationId, explicitIntent: true },
  ]);
});

it("blocks the ordinary composer without losing text while a plan request is unknown", async () => {
  const user = userEvent.setup();
  const approvalId = "43000000-0000-4000-8000-000000000091";
  const turnId = "43000000-0000-4000-8000-000000000092";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(approvalId).mockReturnValueOnce(turnId);
  const reviewGoal = { ...baseGoal, status: "draft", agentState: "contract_review", currentPlanVersionId: null };
  const planningGoal = { ...reviewGoal, version: 6, agentState: "planning" };
  const contractDraft = {
    id: "43000000-0000-4000-8000-000000000093", ownerId, goalId, kind: "goal_contract", status: "pending",
    contentHash: "9".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: { schemaVersion: 2, baseGoalVersion: 5, contract: {
      title: reviewGoal.title, category: "learning", desiredOutcome: reviewGoal.desiredOutcome,
      definitionOfDone: reviewGoal.definitionOfDone, deadline: reviewGoal.deadline, weeklyMinutes: reviewGoal.weeklyMinutes,
      constraints: [], motivation: reviewGoal.motivation,
    }, assumptions: [] },
  };
  const initial = workspace({ goal: reviewGoal, currentPlan: null, planHistory: [], pendingDrafts: [contractDraft] });
  const planning = workspace({ goal: planningGoal, currentPlan: null, planHistory: [], pendingDrafts: [] });
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewGoal)] }));
    if (url === `/api/goals/${goalId}`) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? initial : planning }));
    }
    if (url === "/api/approvals") return Promise.resolve(Response.json({ ok: true, data: { goal: planningGoal } }));
    if (url === "/api/agent/turn") return Promise.reject(new TypeError("lost plan response"));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "批准目标契约（草案 1 / 目标 5）" }));
  expect(await screen.findByRole("button", { name: "查询本次结果" })).toBeEnabled();
  const composer = screen.getByLabelText("告诉教练你的目标");
  await user.type(composer, "不要丢失这段未发送文字");
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(composer).toHaveValue("不要丢失这段未发送文字");
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1);
});

it("retains plan-timeout context across failed reconciliation without claiming task controls", async () => {
  const user = userEvent.setup();
  const approvalId = "43000000-0000-4000-8000-000000000094";
  const turnId = "43000000-0000-4000-8000-000000000095";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(approvalId).mockReturnValueOnce(turnId);
  const reviewGoal = { ...baseGoal, status: "draft", agentState: "contract_review", currentPlanVersionId: null };
  const planningGoal = { ...reviewGoal, version: 6, agentState: "planning" };
  const contractDraft = {
    id: "43000000-0000-4000-8000-000000000096", ownerId, goalId, kind: "goal_contract", status: "pending",
    contentHash: "8".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: { schemaVersion: 2, baseGoalVersion: 5, contract: {
      title: reviewGoal.title, category: "learning", desiredOutcome: reviewGoal.desiredOutcome,
      definitionOfDone: reviewGoal.definitionOfDone, deadline: reviewGoal.deadline, weeklyMinutes: reviewGoal.weeklyMinutes,
      constraints: [], motivation: reviewGoal.motivation,
    }, assumptions: [] },
  };
  const initial = workspace({ goal: reviewGoal, currentPlan: null, planHistory: [], pendingDrafts: [contractDraft] });
  const planning = workspace({ goal: planningGoal, currentPlan: null, planHistory: [], pendingDrafts: [] });
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewGoal)] }));
    if (url === `/api/goals/${goalId}`) {
      goalReads += 1;
      if (goalReads === 1) return Promise.resolve(Response.json({ ok: true, data: initial }));
      if (goalReads === 3) return Promise.reject(new TypeError("lost reconciliation read"));
      return Promise.resolve(Response.json({ ok: true, data: planning }));
    }
    if (url === "/api/approvals") return Promise.resolve(Response.json({ ok: true, data: { goal: planningGoal } }));
    if (url === "/api/agent/turn") return Promise.resolve(Response.json({
      ok: false,
      error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" },
    }, { status: 504 }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "批准目标契约（草案 1 / 目标 5）" }));
  expect(await screen.findByText("模型响应超时，且目标状态读取失败。请先重新读取目标状态；确认前请勿重新生成。")).toBeInTheDocument();
  const composer = screen.getByLabelText("告诉教练你的目标");
  await user.type(composer, "刷新后仍保留");
  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));

  expect(await screen.findByText("模型响应超时，已进入手动恢复模式。已保存目标仍保留；当前尚无计划任务，可重新生成计划草案或返回使用可用的目标控件。")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "重新生成计划草案" })).toBeEnabled();
  expect(screen.queryByRole("heading", { name: "任务" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "编辑计划任务" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "查询本次结果" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(composer).toHaveValue("刷新后仍保留");
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1);
});

it("keeps the committed-contract follow-up request at goal scope and reopens the saved plan draft", async () => {
  const user = userEvent.setup();
  const approvalId = "43000000-0000-4000-8000-000000000081";
  const turnId = "43000000-0000-4000-8000-000000000082";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(approvalId).mockReturnValueOnce(turnId);
  const reviewGoal = { ...baseGoal, status: "draft", agentState: "contract_review", currentPlanVersionId: null,
    desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
  const approvedGoal = { ...baseGoal, status: "draft", agentState: "planning", currentPlanVersionId: null, version: 6 };
  const contractDraft = {
    id: "43000000-0000-4000-8000-000000000083", ownerId, goalId, kind: "goal_contract", status: "pending",
    contentHash: "d".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: { schemaVersion: 2, baseGoalVersion: 5, contract: {
      title: baseGoal.title, category: "learning", desiredOutcome: baseGoal.desiredOutcome,
      definitionOfDone: baseGoal.definitionOfDone, deadline: baseGoal.deadline, weeklyMinutes: baseGoal.weeklyMinutes,
      constraints: [], motivation: baseGoal.motivation,
    }, assumptions: [] },
  };
  const taskIds = [
    "43000000-0000-4000-8000-000000000084",
    "43000000-0000-4000-8000-000000000085",
    "43000000-0000-4000-8000-000000000086",
  ];
  const planDraft = {
    id: "43000000-0000-4000-8000-000000000087", ownerId, goalId, kind: "plan", status: "pending",
    contentHash: "e".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: { schemaVersion: 2, milestones: ["基础", "交互", "持久化"], base: { planVersionId: null, goalVersion: 7 },
      changeReason: null, changeSource: "agent", executionResets: [],
      tasks: taskIds.map((id, index) => ({ id, title: `计划任务 ${index + 1}`, action: `行动 ${index + 1}`,
        doneCriteria: `标准 ${index + 1}`, evidenceType: "text", estimateMinutes: 60, dueAt: null,
        dependencyIds: index ? [taskIds[index - 1]] : [] })),
      diff: { added: taskIds, removed: [], moved: [], changed: [] } },
  };
  const initial = workspace({ goal: reviewGoal, currentPlan: null, planHistory: [], pendingDrafts: [contractDraft] });
  const planning = workspace({ goal: approvedGoal, currentPlan: null, planHistory: [], pendingDrafts: [] });
  const reviewing = workspace({ goal: { ...approvedGoal, version: 7, agentState: "plan_review" }, currentPlan: null, planHistory: [], pendingDrafts: [planDraft] });
  const workspaceQueue = [initial, planning, reviewing];
  let agentCalls = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewGoal)] }));
    if (url === `/api/goals/${goalId}`) return Promise.resolve(Response.json({ ok: true, data: workspaceQueue.shift() ?? reviewing }));
    if (url === "/api/approvals") return Promise.resolve(Response.json({ ok: true, data: { goal: approvedGoal } }));
    if (url === "/api/agent/turn") {
      agentCalls += 1;
      if (agentCalls === 1) return Promise.reject(new TypeError("lost plan response"));
      return Promise.resolve(Response.json({ ok: true, data: {
        message: "计划草案已保存", state: "plan_review", draftId: planDraft.id, persistedChange: true,
        usage: { inputTokens: 0, outputTokens: 0, modelCalls: 2, toolCalls: 1 },
      } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "批准目标契约（草案 1 / 目标 5）" }));
  await user.click(await screen.findByRole("button", { name: "查询本次结果" }));

  expect(await screen.findByRole("heading", { name: "计划草案" })).toBeInTheDocument();
  const turnBodies = fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn").map(([, init]) => JSON.parse(String(init?.body)));
  expect(turnBodies).toEqual([
    { goalId, message: "请根据已批准的目标契约生成计划草案。", requestOperationId: turnId, explicitIntent: true },
    { goalId, message: "请根据已批准的目标契约生成计划草案。", requestOperationId: turnId, explicitIntent: true },
  ]);
});

it("ignores a completed plan request after navigation to another goal", async () => {
  const user = userEvent.setup();
  const otherGoalId = "43000000-0000-4000-8000-000000000050";
  const approvalId = "43000000-0000-4000-8000-000000000051";
  const turnId = "43000000-0000-4000-8000-000000000052";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(approvalId).mockReturnValueOnce(turnId);
  const reviewGoal = { ...baseGoal, status: "draft", agentState: "contract_review", currentPlanVersionId: null };
  const planningGoal = { ...reviewGoal, version: 6, agentState: "planning" };
  const otherGoal = { ...baseGoal, id: otherGoalId, title: "另一个目标", status: "draft", agentState: "clarifying", currentPlanVersionId: null };
  const contractDraft = {
    id: "43000000-0000-4000-8000-000000000053", ownerId, goalId, kind: "goal_contract", status: "pending",
    contentHash: "f".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: { schemaVersion: 2, baseGoalVersion: 5, contract: {
      title: reviewGoal.title, category: "learning", desiredOutcome: reviewGoal.desiredOutcome,
      definitionOfDone: reviewGoal.definitionOfDone, deadline: reviewGoal.deadline, weeklyMinutes: reviewGoal.weeklyMinutes,
      constraints: [], motivation: reviewGoal.motivation,
    }, assumptions: [] },
  };
  const initial = workspace({ goal: reviewGoal, currentPlan: null, planHistory: [], pendingDrafts: [contractDraft] });
  const planning = workspace({ goal: planningGoal, currentPlan: null, planHistory: [], pendingDrafts: [] });
  const other = workspace({ goal: otherGoal, currentPlan: null, planHistory: [], pendingDrafts: [], conversation: { summary: null, recentMessages: [] } });
  let goalOneReads = 0;
  let finishTurn: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewGoal), summary(otherGoal)] }));
    if (url === `/api/goals/${goalId}`) {
      goalOneReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalOneReads === 1 ? initial : planning }));
    }
    if (url === `/api/goals/${otherGoalId}`) return Promise.resolve(Response.json({ ok: true, data: other }));
    if (url === "/api/approvals") return Promise.resolve(Response.json({ ok: true, data: { goal: planningGoal } }));
    if (url === "/api/agent/turn" && init?.method === "POST") {
      return new Promise<Response>(resolve => { finishTurn = resolve; });
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "批准目标契约（草案 1 / 目标 5）" }));
  expect(await screen.findByText("正在生成计划草案…")).toBeInTheDocument();
  view.rerender(<GoalWorkspace goalId={otherGoalId} />);
  expect(await screen.findByRole("heading", { name: "另一个目标" })).toBeInTheDocument();

  finishTurn?.(Response.json({ ok: true, data: {
    message: "旧目标计划已保存", state: "plan_review", persistedChange: true,
    usage: { inputTokens: 0, outputTokens: 0, modelCalls: 2, toolCalls: 1 },
  } }));
  await Promise.resolve();
  await Promise.resolve();

  expect(screen.getByRole("heading", { name: "另一个目标" })).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => url === `/api/goals/${goalId}`)).toHaveLength(2);
  expect(screen.queryByText("旧目标计划已保存")).not.toBeInTheDocument();
});

it("treats a committed plan draft plus failed refresh as refresh-only recovery", async () => {
  const user = userEvent.setup();
  const approvalId = "43000000-0000-4000-8000-000000000060";
  const turnId = "43000000-0000-4000-8000-000000000061";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(approvalId).mockReturnValueOnce(turnId);
  const reviewGoal = { ...baseGoal, status: "draft", agentState: "contract_review", currentPlanVersionId: null };
  const planningGoal = { ...reviewGoal, version: 6, agentState: "planning" };
  const reviewingGoal = { ...planningGoal, version: 7, agentState: "plan_review" };
  const contractDraft = {
    id: "43000000-0000-4000-8000-000000000062", ownerId, goalId, kind: "goal_contract", status: "pending",
    contentHash: "1".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: { schemaVersion: 2, baseGoalVersion: 5, contract: {
      title: reviewGoal.title, category: "learning", desiredOutcome: reviewGoal.desiredOutcome,
      definitionOfDone: reviewGoal.definitionOfDone, deadline: reviewGoal.deadline, weeklyMinutes: reviewGoal.weeklyMinutes,
      constraints: [], motivation: reviewGoal.motivation,
    }, assumptions: [] },
  };
  const taskIds = [
    "43000000-0000-4000-8000-000000000063",
    "43000000-0000-4000-8000-000000000064",
    "43000000-0000-4000-8000-000000000065",
  ];
  const planDraft = {
    id: "43000000-0000-4000-8000-000000000066", ownerId, goalId, kind: "plan", status: "pending",
    contentHash: "2".repeat(64), createdAt: now, updatedAt: now, version: 1,
    payload: { schemaVersion: 2, milestones: ["基础", "交互", "持久化"], base: { planVersionId: null, goalVersion: 7 },
      changeReason: null, changeSource: "agent", executionResets: [],
      tasks: taskIds.map((id, index) => ({ id, title: `恢复任务 ${index + 1}`, action: `行动 ${index + 1}`,
        doneCriteria: `标准 ${index + 1}`, evidenceType: "text", estimateMinutes: 60, dueAt: null,
        dependencyIds: index ? [taskIds[index - 1]] : [] })),
      diff: { added: taskIds, removed: [], moved: [], changed: [] } },
  };
  const initial = workspace({ goal: reviewGoal, currentPlan: null, planHistory: [], pendingDrafts: [contractDraft] });
  const planning = workspace({ goal: planningGoal, currentPlan: null, planHistory: [], pendingDrafts: [] });
  const reviewing = workspace({ goal: reviewingGoal, currentPlan: null, planHistory: [], pendingDrafts: [planDraft] });
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewGoal)] }));
    if (url === `/api/goals/${goalId}`) {
      goalReads += 1;
      if (goalReads === 1) return Promise.resolve(Response.json({ ok: true, data: initial }));
      if (goalReads === 2) return Promise.resolve(Response.json({ ok: true, data: planning }));
      if (goalReads === 3 || goalReads === 4) return Promise.reject(new TypeError("lost refresh"));
      return Promise.resolve(Response.json({ ok: true, data: reviewing }));
    }
    if (url === "/api/approvals") return Promise.resolve(Response.json({ ok: true, data: { goal: planningGoal } }));
    if (url === "/api/agent/turn") return Promise.resolve(Response.json({ ok: true, data: {
      message: "计划草案已保存", state: "plan_review", draftId: planDraft.id, persistedChange: true,
      usage: { inputTokens: 0, outputTokens: 0, modelCalls: 2, toolCalls: 1 },
    } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "批准目标契约（草案 1 / 目标 5）" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("计划草案已经生成，但重新读取目标状态失败");
  expect(screen.queryByRole("button", { name: "查询本次结果" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("计划草案已经生成，但重新读取目标状态失败");
  expect(screen.queryByRole("button", { name: "查询本次结果" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  expect(await screen.findByRole("heading", { name: "计划草案" })).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1);
});

it("renders formal progress and pauses with the displayed Goal version", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000111";
  const pausedGoal = { ...baseGoal, status: "paused" as const, agentState: "paused" as const, version: 6 };
  const initial = executionWorkspace();
  const paused = executionWorkspace({ goal: pausedGoal });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? initial : paused }));
    }
    if (url === `/api/goals/${goalId}` && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: pausedGoal }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByRole("progressbar", { name: "目标正式完成进度" })).toHaveValue(0);
  expect(screen.getByText("2026-10-14")).toBeInTheDocument();
  expect(screen.getByText("420 分钟")).toBeInTheDocument();
  expect(screen.getByText("按30分钟起步窗口推荐")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "暂停目标" }));

  await screen.findByText("已暂停");
  const statusBody = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}` && init?.method === "PATCH")?.[1]?.body));
  expect(statusBody).toEqual({ status: "paused", expectedVersion: 5, operationId });
});

it("replays an unknown execution request with its exact admitted body and operation id", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000112";
  const updatedTask = { ...executionTask, status: "doing" as const, version: 3 };
  const refreshed = executionWorkspace({
    goal: { ...baseGoal, version: 6 }, tasks: [updatedTask],
    nextAction: { task: updatedTask, suggestedSliceMinutes: 30, reasons: ["按30分钟起步窗口推荐"] },
  });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  let patchCalls = 0;
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? executionWorkspace() : refreshed }));
    }
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH") {
      patchCalls += 1;
      return patchCalls === 1
        ? Promise.reject(new TypeError("response lost"))
        : Promise.resolve(Response.json({ ok: true, data: updatedTask }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "开始这个任务" }));
  expect(await screen.findByRole("button", { name: "查询本次修改结果" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "暂停目标" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "查询本次修改结果" }));

  await waitFor(() => expect(screen.queryByRole("button", { name: "查询本次修改结果" })).not.toBeInTheDocument());
  const bodies = fetchMock.mock.calls.filter(([url, init]) => url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH").map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toEqual([{
    expectedVersion: 2,
    expectedGoalVersion: 5,
    expectedPlanVersion: { id: planId, version: 1 },
    operationId,
    source: "ui_explicit",
    status: "doing",
  }, {
    expectedVersion: 2,
    expectedGoalVersion: 5,
    expectedPlanVersion: { id: planId, version: 1 },
    operationId,
    source: "ui_explicit",
    status: "doing",
  }]);
  expect(bodies[0]).not.toHaveProperty("goalId");
});

it("keeps known execution success refresh-only when the authoritative refresh fails", async () => {
  const user = userEvent.setup();
  const updatedTask = { ...executionTask, status: "doing" as const, version: 3 };
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      if (goalReads === 2) return Promise.reject(new TypeError("refresh lost"));
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? executionWorkspace() : executionWorkspace({ goal: { ...baseGoal, version: 6 }, tasks: [updatedTask] }) }));
    }
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: updatedTask }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "开始这个任务" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("任务修改已经保存，但重新读取正式状态失败");
  expect(screen.queryByRole("button", { name: "查询本次修改结果" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url, init]) => url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "重新读取正式状态" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重新读取正式状态" })).not.toBeInTheDocument());
  expect(fetchMock.mock.calls.filter(([url, init]) => url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH")).toHaveLength(1);
});

it("submits a complete manual plan against the editor's captured base and opens review without an agent call", async () => {
  const user = userEvent.setup();
  const taskTwo = { ...executionTask, id: "43000000-0000-4000-8000-000000000120", title: "第二项", action: "继续实现" };
  const taskThree = { ...executionTask, id: "43000000-0000-4000-8000-000000000121", title: "第三项", action: "完成验证" };
  const originalTasks = [executionTask, taskTwo, taskThree];
  const tempId = "43000000-0000-4000-8000-000000000122";
  const operationId = "43000000-0000-4000-8000-000000000123";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(tempId).mockReturnValueOnce(operationId);
  let goalReads = 0;
  let savedDraft: Record<string, unknown> | null = null;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      const data = executionWorkspace({
        goal: goalReads === 1 ? baseGoal : { ...baseGoal, version: 7, agentState: "plan_review" },
        tasks: originalTasks,
        pendingDrafts: savedDraft ? [savedDraft] : [],
      });
      return Promise.resolve(Response.json({ ok: true, data }));
    }
    if (url === `/api/goals/${goalId}/plan-drafts` && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      savedDraft = {
        id: "43000000-0000-4000-8000-000000000124", ownerId, goalId, kind: "replan", status: "pending",
        contentHash: "a".repeat(64), createdAt: now, updatedAt: now, version: 1,
        payload: { schemaVersion: 2, milestones: currentPlan.milestones, base: { planVersionId: planId, goalVersion: 7 },
          changeReason: body.changeReason, changeSource: "user", tasks: body.tasks, executionResets: [],
          diff: { added: [tempId], removed: [], moved: [], changed: [executionTask.id] } },
      };
      return Promise.resolve(Response.json({ ok: true, data: savedDraft }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: `编辑：${executionTask.title}` }));
  await user.clear(screen.getByLabelText(`行动：${executionTask.title}`));
  await user.type(screen.getByLabelText(`行动：${executionTask.title}`), "编辑后的行动");
  await user.click(screen.getByRole("button", { name: "添加任务" }));
  await user.type(screen.getByLabelText("标题：新任务 4"), "离线新增项");
  await user.type(screen.getByLabelText("行动：离线新增项"), "离线完成新增项");
  await user.type(screen.getByLabelText("完成标准：离线新增项"), "新增项可核对");
  await user.type(screen.getByLabelText("修改原因"), "模型不可用时手动调整");
  await user.click(screen.getByRole("button", { name: "生成计划草案并审阅" }));

  expect(await screen.findByRole("heading", { name: "计划草案" })).toBeInTheDocument();
  const draftCall = fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}/plan-drafts` && init?.method === "POST");
  const body = JSON.parse(String(draftCall?.[1]?.body));
  expect(body).toMatchObject({
    expectedPlanVersion: { id: planId, version: 1 }, expectedGoalVersion: 5,
    changeReason: "模型不可用时手动调整", operationId,
  });
  expect(body.tasks).toHaveLength(4);
  expect(body.tasks[0]).toMatchObject({ id: executionTask.id, action: "编辑后的行动" });
  expect(body.tasks[3]).toMatchObject({ id: tempId, title: "离线新增项" });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/tasks/") && init?.method === "PATCH")).toBe(false);
  expect(screen.getByRole("list", { name: "当前计划里程碑" })).toHaveTextContent("验证数据保留");
});

it("completes with typed evidence atomically, then undoes formal progress while retaining evidence history", async () => {
  const user = userEvent.setup();
  const completionId = "43000000-0000-4000-8000-000000000140";
  const undoId = "43000000-0000-4000-8000-000000000141";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(completionId).mockReturnValueOnce(undoId);
  const completedTask = { ...executionTask, status: "done" as const, version: 3 };
  const restoredTask = { ...executionTask, version: 4 };
  const evidence = {
    id: "43000000-0000-4000-8000-000000000142", ownerId, goalId, taskId: executionTask.id,
    type: "text" as const, text: "已完成正式验证", fileName: null, fileSize: null, mimeType: null,
    createdAt: now, updatedAt: now, version: 1,
  };
  const states = [
    executionWorkspace(),
    executionWorkspace({ goal: { ...baseGoal, version: 6 }, tasks: [completedTask], evidence: [evidence], progress: { completed: 1, total: 1, percent: 100 }, nextAction: null, canUndo: true, undoCandidate: { id: "43000000-0000-4000-8000-000000000142", kind: "task_execution", label: "任务修改" } }),
    executionWorkspace({ goal: { ...baseGoal, version: 7 }, tasks: [restoredTask], evidence: [evidence], progress: { completed: 0, total: 1, percent: 0 }, nextAction: { task: restoredTask, suggestedSliceMinutes: 30, reasons: ["按30分钟起步窗口推荐"] }, canUndo: false }),
  ];
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: states[goalReads++] ?? states.at(-1) }));
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: completedTask }));
    if (url === `/api/goals/${goalId}/undo` && init?.method === "POST") return Promise.resolve(Response.json({ ok: true, data: { task: restoredTask } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: `完成：${executionTask.title}` }));
  await user.type(screen.getByLabelText("文字说明"), " 已完成正式验证 ");
  await user.click(screen.getByRole("button", { name: "确认完成并保存证据" }));
  expect(await screen.findByRole("progressbar", { name: "目标正式完成进度" })).toHaveValue(100);
  expect(screen.getByText("完成证据")).toBeInTheDocument();
  expect(screen.getByText("已完成正式验证")).toBeInTheDocument();

  const completionBody = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH")?.[1]?.body));
  expect(completionBody).toEqual({
    expectedVersion: 2, expectedGoalVersion: 5, expectedPlanVersion: { id: planId, version: 1 },
    operationId: completionId, source: "ui_explicit", status: "done", evidence: { type: "text", text: "已完成正式验证" },
  });

  await user.click(screen.getByRole("button", { name: "撤销上一次修改" }));
  await waitFor(() => expect(screen.getByRole("progressbar", { name: "目标正式完成进度" })).toHaveValue(0));
  expect(screen.getByText("历史证据（不表示当前已完成）")).toBeInTheDocument();
  const undoBody = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}/undo` && init?.method === "POST")?.[1]?.body));
  expect(undoBody).toEqual({ operationId: undoId, expectedUndoId: "43000000-0000-4000-8000-000000000142", expectedGoalVersion: 6 });
});

it.each([false, true])("binds feedback undo to its displayed candidate and reconciles stale responses: %s", async stale => {
  const user = userEvent.setup();
  const candidate = { id: "43000000-0000-4000-8000-000000000143", kind: "check_in", label: "最近一次阻碍反馈" };
  const checkIn = blockerCheckIn();
  const withdrawn = { ...checkIn, withdrawnAt: now, version: 2 };
  let submitted = false;
  const initial = executionWorkspace({ canUndo: true, undoCandidate: candidate, checkIns: [checkIn] });
  const refreshed = executionWorkspace({ goal: { ...baseGoal, version: 6 }, checkIns: [stale ? checkIn : withdrawn], effectiveCheckIns: stale ? [checkIn] : [] });
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary()] }));
    if (url === `/api/goals/${goalId}`) return Promise.resolve(Response.json({ ok: true, data: submitted ? refreshed : initial }));
    if (url === `/api/goals/${goalId}/undo` && init?.method === "POST") {
      submitted = true;
      expect(JSON.parse(String(init.body))).toMatchObject({ expectedUndoId: candidate.id, expectedGoalVersion: 5, operationId: expect.any(String) });
      return Promise.resolve(stale ? Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "refresh" } }, { status: 409 }) : Response.json({ ok: true, data: { checkIn: withdrawn } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);
  await user.click(await screen.findByRole("button", { name: "撤销上一次修改" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "撤销上一次修改" })).not.toBeInTheDocument());
  await user.click(screen.getByText("反馈历史（1）"));
  expect(screen.getByText(stale ? "已记录" : "已撤销", { exact: true })).toBeVisible();
  expect(screen.queryByText("结果未确认")).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/undo"))).toHaveLength(1);
});

it("deletes the last task with exact versions, validates null, and refreshes successor plan ids without losing milestones", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000150";
  const successorPlanId = "43000000-0000-4000-8000-000000000151";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const successorPlan = { ...currentPlan, id: successorPlanId, number: 2, version: 1 };
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? executionWorkspace() : executionWorkspace({
        goal: { ...baseGoal, currentPlanVersionId: successorPlanId, version: 6 }, currentPlan: successorPlan,
        tasks: [], progress: { completed: 0, total: 0, percent: 0 }, nextAction: null,
      }) }));
    }
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "DELETE") return Promise.resolve(Response.json({ ok: true, data: null }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: `删除：${executionTask.title}` }));
  await user.type(screen.getByLabelText(`输入任务标题“${executionTask.title}”确认删除`), executionTask.title);
  await user.click(screen.getByRole("button", { name: "确认删除任务" }));

  expect(await screen.findByText("当前计划没有待执行任务")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "当前计划里程碑" })).toHaveTextContent("验证数据保留");
  expect(screen.queryByText(executionTask.title)).not.toBeInTheDocument();
  const deleteBody = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "DELETE")?.[1]?.body));
  expect(deleteBody).toEqual({
    source: "ui_confirmation", confirmationPhrase: executionTask.title, expectedTaskVersion: 2,
    expectedGoalVersion: 5, operationId,
  });
});

it("keeps a paused goal paused after approving its manual plan draft", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000160";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const pausedGoal = { ...baseGoal, status: "paused" as const, agentState: "paused" as const, version: 5 };
  const draft = pendingReplan();
  const approvedPlan: Record<string, unknown> = { ...currentPlan };
  delete approvedPlan.milestones;
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(pausedGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: executionWorkspace({ goal: { ...pausedGoal, version: goalReads === 1 ? 5 : 6 }, pendingDrafts: goalReads === 1 ? [draft] : [] }) }));
    }
    if (url === "/api/approvals" && init?.method === "POST") return Promise.resolve(Response.json({ ok: true, data: { plan: approvedPlan, tasks: [executionTask] } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "批准新计划（草案 1 / 目标 5）" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "计划草案" })).not.toBeInTheDocument());
  expect(screen.getByText("已暂停")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "恢复目标" })).toBeEnabled();
  expect(screen.getByRole("button", { name: `开始：${executionTask.title}` })).toBeDisabled();
  expect(screen.getByRole("button", { name: `编辑：${executionTask.title}` })).toBeEnabled();
  expect(screen.getByRole("button", { name: `删除：${executionTask.title}` })).toBeEnabled();
});

it("does not let a late old-goal execution result refresh the newly selected goal", async () => {
  const user = userEvent.setup();
  const otherGoalId = "43000000-0000-4000-8000-000000000170";
  const otherGoal = { ...baseGoal, id: otherGoalId, title: "新的目标" };
  const otherWorkspace = executionWorkspace({ goal: otherGoal, currentPlan: { ...currentPlan, goalId: otherGoalId }, tasks: [], progress: { completed: 0, total: 0, percent: 0 }, nextAction: null });
  let finishPatch: ((response: Response) => void) | undefined;
  let oldReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal), summary(otherGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) { oldReads += 1; return Promise.resolve(Response.json({ ok: true, data: executionWorkspace() })); }
    if (url === `/api/goals/${otherGoalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: otherWorkspace }));
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH") return new Promise<Response>(resolve => { finishPatch = resolve; });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "开始这个任务" }));
  view.rerender(<GoalWorkspace goalId={otherGoalId} />);
  expect(await screen.findByRole("heading", { name: "新的目标" })).toBeInTheDocument();
  finishPatch?.(Response.json({ ok: true, data: { ...executionTask, status: "doing", version: 3 } }));
  await Promise.resolve();
  await Promise.resolve();

  expect(screen.getByRole("heading", { name: "新的目标" })).toBeInTheDocument();
  expect(oldReads).toBe(1);
});

it("keeps the editor's original base tuple when a pause refresh occurs before manual submission", async () => {
  const user = userEvent.setup();
  const pauseId = "43000000-0000-4000-8000-000000000180";
  const draftId = "43000000-0000-4000-8000-000000000181";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(pauseId).mockReturnValueOnce(draftId);
  const tasks = [executionTask, { ...executionTask, id: "43000000-0000-4000-8000-000000000182", title: "第二项" }, { ...executionTask, id: "43000000-0000-4000-8000-000000000183", title: "第三项" }];
  const pausedGoal = { ...baseGoal, status: "paused" as const, agentState: "paused" as const, version: 6 };
  let goalReads = 0;
  let submittedBody: Record<string, unknown> | null = null;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: executionWorkspace({ goal: goalReads === 1 ? baseGoal : pausedGoal, tasks }) }));
    }
    if (url === `/api/goals/${goalId}` && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: pausedGoal }));
    if (url === `/api/goals/${goalId}/plan-drafts` && init?.method === "POST") {
      submittedBody = JSON.parse(String(init.body));
      return Promise.resolve(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "refresh" } }, { status: 409 }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: `编辑：${executionTask.title}` }));
  await user.clear(screen.getByLabelText(`行动：${executionTask.title}`));
  await user.type(screen.getByLabelText(`行动：${executionTask.title}`), "尚未保存的旧基线编辑");
  await user.click(screen.getByRole("button", { name: "暂停目标" }));
  await screen.findByText("已暂停");
  await user.type(screen.getByLabelText("修改原因"), "保留开始编辑时的基线");
  await user.click(screen.getByRole("button", { name: "生成计划草案并审阅" }));

  await waitFor(() => expect(submittedBody).not.toBeNull());
  expect(submittedBody).toMatchObject({ expectedGoalVersion: 5, expectedPlanVersion: { id: planId, version: 1 }, operationId: draftId });
  expect((submittedBody as unknown as { tasks: Array<{ action: string }> }).tasks[0].action).toBe("尚未保存的旧基线编辑");
});

it("locks task execution synchronously while plan approval owns the fresh mutation lease", async () => {
  const user = userEvent.setup();
  const draft = pendingReplan();
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: executionWorkspace({ pendingDrafts: [draft] }) }));
    if (url === "/api/approvals" && init?.method === "POST") return new Promise<Response>(() => undefined);
    throw new Error(`Unexpected ${url}`);
  }));
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "批准新计划（草案 1 / 目标 5）" }));
  expect(screen.getByRole("button", { name: "开始这个任务" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "暂停目标" })).toBeDisabled();
});

it("serializes explicit refresh and exact-request lookup in both overlap orders", async () => {
  const user = userEvent.setup();
  let patchCalls = 0;
  let goalReads = 0;
  let finishRefresh: ((response: Response) => void) | undefined;
  let finishReplay: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      if (goalReads === 1) return Promise.resolve(Response.json({ ok: true, data: executionWorkspace() }));
      if (goalReads === 2) return new Promise<Response>(resolve => { finishRefresh = resolve; });
      return Promise.resolve(Response.json({ ok: true, data: executionWorkspace({ goal: { ...baseGoal, version: 6 } }) }));
    }
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH") {
      patchCalls += 1;
      if (patchCalls === 1) return Promise.reject(new TypeError("response lost"));
      return new Promise<Response>(resolve => { finishReplay = resolve; });
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "开始这个任务" }));
  const queryBeforeRefresh = await screen.findByRole("button", { name: "查询本次修改结果" });
  await user.click(screen.getByRole("button", { name: "重新读取正式状态" }));
  fireEvent.click(queryBeforeRefresh);
  expect(patchCalls).toBe(1);
  finishRefresh?.(Response.json({ ok: true, data: executionWorkspace() }));
  expect(await screen.findByRole("button", { name: "查询本次修改结果" })).toBeEnabled();

  const refreshBeforeReplay = screen.getByRole("button", { name: "重新读取正式状态" });
  await user.click(screen.getByRole("button", { name: "查询本次修改结果" }));
  fireEvent.click(refreshBeforeReplay);
  expect(goalReads).toBe(2);
  expect(patchCalls).toBe(2);
  finishReplay?.(Response.json({ ok: true, data: { ...executionTask, status: "doing", version: 3 } }));
  await waitFor(() => expect(goalReads).toBe(3));
  expect(screen.queryByRole("button", { name: "查询本次修改结果" })).not.toBeInTheDocument();
});

it("records actual minutes with only the strict execution fields and displayed versions", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000190";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const updatedTask = { ...executionTask, actualMinutes: 25, version: 3 };
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? executionWorkspace() : executionWorkspace({ goal: { ...baseGoal, version: 6 }, tasks: [updatedTask] }) }));
    }
    if (url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: updatedTask }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  const minutes = await screen.findByRole("spinbutton", { name: "实际用时（分钟）" });
  await user.type(minutes, "25");
  await user.tab();

  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH")).toBe(true));
  const body = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url === `/api/goals/${goalId}/tasks/${executionTask.id}` && init?.method === "PATCH")?.[1]?.body));
  expect(body).toEqual({
    expectedVersion: 2, expectedGoalVersion: 5, expectedPlanVersion: { id: planId, version: 1 },
    operationId, source: "ui_explicit", actualMinutes: 25,
  });
  expect(body).not.toHaveProperty("status");
  expect(body).not.toHaveProperty("evidence");
  expect(body).not.toHaveProperty("goalId");
});

it("renders a deterministic replan trigger without an agent call until explicit evaluation", async () => {
  const user = userEvent.setup();
  const requestId = "43000000-0000-4000-8000-000000000211";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(requestId);
  const triggered = executionWorkspace({
    nextAction: null,
    tasks: [{ ...executionTask, status: "skipped" as const }],
    replanTriggers: [{ code: "repeated_skip", taskId: executionTask.id, reason: "同一任务已连续跳过两次" }],
  });
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: triggered }));
    if (url === "/api/agent/turn" && init?.method === "POST") return Promise.resolve(Response.json({ ok: true, data: blockerAdviceResult }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByRole("heading", { name: "计划可能需要调整" })).toBeInTheDocument();
  expect(screen.getByText("同一任务已连续跳过两次")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
  await user.click(screen.getByRole("button", { name: "报告阻碍" }));
  expect(screen.getByText(`这次记录关联任务：${executionTask.title}`)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "取消" }));

  await user.click(screen.getByRole("button", { name: "请教练评估" }));
  await screen.findByText("先用 5 分钟列出一个最小步骤");
  const body = JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === "/api/agent/turn")?.[1]?.body));
  expect(body).toEqual({ goalId, message: "请根据最新反馈调整计划。", requestOperationId: requestId, explicitIntent: true });
});

it("starts a fresh active evaluation with the preserved message and a new request id", async () => {
  const user = userEvent.setup();
  const firstRequestId = "43000000-0000-4000-8000-000000000231";
  const retryRequestId = "43000000-0000-4000-8000-000000000232";
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(firstRequestId)
    .mockReturnValueOnce(retryRequestId);
  const triggered = executionWorkspace({
    replanTriggers: [{ code: "repeated_skip", taskId: executionTask.id, reason: "同一任务已连续跳过两次" }],
  });
  let turnWrites = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: triggered }));
    if (url === "/api/agent/turn" && init?.method === "POST") {
      turnWrites += 1;
      return turnWrites === 1
        ? Promise.resolve(Response.json({ ok: false, error: { code: "INVALID_TRANSITION", message: "暂时不可用" } }, { status: 409 }))
        : Promise.resolve(Response.json({ ok: true, data: blockerAdviceResult }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "请教练评估" }));
  await user.click(await screen.findByRole("button", { name: "显式发起新一轮" }));
  await screen.findByText("先用 5 分钟列出一个最小步骤");

  const bodies = fetchMock.mock.calls
    .filter(([url]) => url === "/api/agent/turn")
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toEqual([
    { goalId, message: "请根据最新反馈调整计划。", requestOperationId: firstRequestId, explicitIntent: true },
    { goalId, message: "请根据最新反馈调整计划。", requestOperationId: retryRequestId, explicitIntent: true },
  ]);
});

it("shows active-goal manual controls after a reconciled model timeout", async () => {
  const user = userEvent.setup();
  const requestId = "43000000-0000-4000-8000-000000000236";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(requestId);
  const triggered = executionWorkspace({
    replanTriggers: [{ code: "repeated_skip", taskId: executionTask.id, reason: "同一任务已连续跳过两次" }],
  });
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: triggered }));
    if (url === "/api/agent/turn" && init?.method === "POST") {
      return Promise.resolve(Response.json({
        ok: false,
        error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" },
      }, { status: 504 }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "请教练评估" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("模型响应超时，已进入手动模式");
  expect(screen.getByRole("button", { name: "编辑计划任务" })).toBeEnabled();
  expect(screen.getByRole("button", { name: `编辑：${executionTask.title}` })).toBeEnabled();
  expect(screen.getByRole("button", { name: "显式发起新一轮" })).toBeEnabled();
});

it("does not allocate or send a fresh evaluation after reconciled error when the goal is paused", async () => {
  const user = userEvent.setup();
  const firstRequestId = "43000000-0000-4000-8000-000000000233";
  const pauseOperationId = "43000000-0000-4000-8000-000000000234";
  const forbiddenRetryId = "43000000-0000-4000-8000-000000000235";
  const uuid = vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(firstRequestId)
    .mockReturnValueOnce(pauseOperationId)
    .mockReturnValue(forbiddenRetryId);
  const triggered = executionWorkspace({
    replanTriggers: [{ code: "repeated_skip", taskId: executionTask.id, reason: "同一任务已连续跳过两次" }],
  });
  const pausedGoal = { ...baseGoal, status: "paused" as const, agentState: "paused" as const, version: 6 };
  const paused = executionWorkspace({ goal: pausedGoal });
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads < 3 ? triggered : paused }));
    }
    if (url === `/api/goals/${goalId}` && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: pausedGoal }));
    if (url === "/api/agent/turn" && init?.method === "POST") {
      return Promise.resolve(Response.json({ ok: false, error: { code: "INVALID_TRANSITION", message: "暂时不可用" } }, { status: 409 }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "请教练评估" }));
  expect(await screen.findByRole("button", { name: "显式发起新一轮" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "暂停目标" }));
  await screen.findByText("已暂停");

  const retry = screen.getByRole("button", { name: "显式发起新一轮" });
  expect(retry).toBeDisabled();
  const uuidCallsBeforeAttempt = uuid.mock.calls.length;
  fireEvent.click(retry);
  expect(uuid).toHaveBeenCalledTimes(uuidCallsBeforeAttempt);
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1);
});

it.each([false, true])("saves a blocker and keeps advice freshness across response loss and withdrawal: %s", async lostResponse => {
  const user = userEvent.setup();
  const checkInId = "43000000-0000-4000-8000-000000000212";
  const turnId = "43000000-0000-4000-8000-000000000213";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(checkInId).mockReturnValueOnce(turnId);
  const saved = blockerCheckIn();
  let withdrawn = false;
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      const data = goalReads === 1 ? executionWorkspace() : withdrawn
        ? executionWorkspace({ goal: { ...baseGoal, version: 7 }, checkIns: [{ ...saved, withdrawnAt: now, version: 2 }], effectiveCheckIns: [] })
        : executionWorkspace({ goal: { ...baseGoal, version: 6 }, checkIns: [saved], canUndo: true, undoCandidate: { id: "43000000-0000-4000-8000-000000000214", kind: "check_in", label: "最近一次阻碍反馈" } });
      return Promise.resolve(Response.json({ ok: true, data }));
    }
    if (url === `/api/goals/${goalId}/check-ins` && init?.method === "POST") return Promise.resolve(Response.json({ ok: true, data: saved }));
    if (url === `/api/goals/${goalId}/undo` && init?.method === "POST") {
      withdrawn = true;
      return Promise.resolve(Response.json({ ok: true, data: { checkIn: { ...saved, withdrawnAt: now, version: 2 } } }));
    }
    if (url === "/api/agent/turn" && init?.method === "POST") {
      if (lostResponse && !withdrawn) { withdrawn = true; return Promise.reject(new TypeError("response lost before another tab withdrew feedback")); }
      return Promise.resolve(Response.json({ ok: true, data: { ...blockerAdviceResult, adviceGoalVersion: 6 } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "报告阻碍" }));
  expect(screen.getByText(`这次记录关联任务：${executionTask.title}`)).toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "时间不足" }));
  await user.type(screen.getByLabelText("补充说明（选填）"), "只有二十分钟");
  await user.click(screen.getByRole("button", { name: "请教练帮我分析" }));

  if (lostResponse) {
    await user.click(await screen.findByRole("button", { name: "查询本次教练结果" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "查询本次教练结果" })).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "最小下一步" })).not.toBeInTheDocument();
    const bodies = fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn").map(([, init]) => init?.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    return;
  }
  await screen.findByText("先用 5 分钟列出一个最小步骤");
  const checkInBody = JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === `/api/goals/${goalId}/check-ins`)?.[1]?.body));
  expect(checkInBody).toEqual({
    taskId: executionTask.id, kind: "blocker", blockerCategory: "insufficient_time", note: "只有二十分钟",
    minutesSpent: null, availableWeeklyMinutes: null, expectedGoalVersion: 5, operationId: checkInId,
  });
  const turnBody = JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === "/api/agent/turn")?.[1]?.body));
  expect(turnBody).toEqual({ goalId, message: "我卡住了，请帮我分析。", requestOperationId: turnId, explicitIntent: true });
  await user.click(screen.getByRole("button", { name: "撤销上一次修改" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "最小下一步" })).not.toBeInTheDocument());
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/agent/turn")).toHaveLength(1);
});

it.each([false, true])("gates replayed advice through pending and failed reconciliation, withdrawn=%s", async withdrawn => {
  const user = userEvent.setup();
  const saved = blockerCheckIn();
  const cached = executionWorkspace({ goal: { ...baseGoal, version: 6 }, checkIns: [saved], replanTriggers: [{ code: "unresolved_blocker", taskId: executionTask.id, reason: "需要分析阻碍" }] });
  const authoritative = withdrawn
    ? executionWorkspace({ goal: { ...baseGoal, version: 7 }, checkIns: [{ ...saved, withdrawnAt: now, version: 2 }], effectiveCheckIns: [] })
    : cached;
  let rejectRefresh!: (reason: Error) => void;
  const pendingRefresh = new Promise<Response>((_resolve, reject) => { rejectRefresh = reject; });
  let resolveRetry!: (response: Response) => void;
  const pendingRetry = new Promise<Response>(resolve => { resolveRetry = resolve; });
  let goalReads = 0;
  const turnBodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads++;
      if (goalReads === 2) return pendingRefresh;
      if (goalReads === 3) return pendingRetry;
      return Promise.resolve(Response.json({ ok: true, data: cached }));
    }
    if (url === "/api/agent/turn" && init?.method === "POST") {
      turnBodies.push(init.body);
      if (turnBodies.length === 1) return Promise.reject(new TypeError("successful advice response lost"));
      return Promise.resolve(Response.json({ ok: true, data: { ...blockerAdviceResult, adviceGoalVersion: 6 } }));
    }
    throw new Error(`Unexpected ${url}`);
  }));
  render(<GoalWorkspace goalId={goalId} />);
  await user.click(await screen.findByRole("button", { name: "请教练评估" }));
  await user.click(await screen.findByRole("button", { name: "查询本次教练结果" }));
  await waitFor(() => expect(goalReads).toBe(2));
  expect.soft(screen.queryByRole("heading", { name: "最小下一步" })).not.toBeInTheDocument();

  await act(async () => { rejectRefresh(new TypeError("workspace refresh failed")); });
  await screen.findByText("教练回复已经收到，但重新读取目标状态失败。");
  expect.soft(screen.queryByRole("heading", { name: "最小下一步" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  await waitFor(() => expect(goalReads).toBe(3));
  expect.soft(screen.queryByRole("heading", { name: "最小下一步" })).not.toBeInTheDocument();

  await act(async () => { resolveRetry(Response.json({ ok: true, data: authoritative })); });
  await waitFor(() => expect(screen.queryByText("教练回复已经收到，但重新读取目标状态失败。")).not.toBeInTheDocument());
  if (withdrawn) expect(screen.queryByRole("heading", { name: "最小下一步" })).not.toBeInTheDocument();
  else expect(screen.getByRole("heading", { name: "最小下一步" })).toBeVisible();
  expect(turnBodies).toHaveLength(2);
  expect(turnBodies[1]).toBe(turnBodies[0]);
});

it("keeps an unknown blocker save exact and waits for explicit continuation after replay", async () => {
  const user = userEvent.setup();
  const checkInId = "43000000-0000-4000-8000-000000000214";
  const turnId = "43000000-0000-4000-8000-000000000215";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(checkInId).mockReturnValueOnce(turnId);
  const saved = blockerCheckIn();
  let goalReads = 0;
  let checkInWrites = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? executionWorkspace() : executionWorkspace({ goal: { ...baseGoal, version: 6 }, checkIns: [saved] }) }));
    }
    if (url === `/api/goals/${goalId}/check-ins` && init?.method === "POST") {
      checkInWrites += 1;
      return checkInWrites === 1 ? Promise.reject(new TypeError("lost response")) : Promise.resolve(Response.json({ ok: true, data: saved }));
    }
    if (url === "/api/agent/turn") return Promise.resolve(Response.json({ ok: true, data: { ...blockerAdviceResult, adviceGoalVersion: 6 } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "报告阻碍" }));
  await user.click(screen.getByRole("radio", { name: "时间不足" }));
  await user.type(screen.getByLabelText("补充说明（选填）"), "只有二十分钟");
  await user.click(screen.getByRole("button", { name: "请教练帮我分析" }));
  await user.click(await screen.findByRole("button", { name: "查询本次修改结果" }));

  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
  const writes = fetchMock.mock.calls.filter(([url]) => url === `/api/goals/${goalId}/check-ins`).map(([, init]) => JSON.parse(String(init?.body)));
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0].operationId).toBe(checkInId);

  await user.click(await screen.findByRole("button", { name: "继续请求教练分析" }));
  await screen.findByText("先用 5 分钟列出一个最小步骤");
  expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === "/api/agent/turn")?.[1]?.body)).requestOperationId).toBe(turnId);
});

it("keeps known blocker success refresh-only, then lets the user decline diagnosis and unlock work", async () => {
  const user = userEvent.setup();
  const checkInId = "43000000-0000-4000-8000-000000000216";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(checkInId);
  const saved = blockerCheckIn();
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      if (goalReads === 2) return Promise.reject(new TypeError("refresh lost"));
      return Promise.resolve(Response.json({ ok: true, data: goalReads === 1 ? executionWorkspace() : executionWorkspace({ goal: { ...baseGoal, version: 6 }, checkIns: [saved] }) }));
    }
    if (url === `/api/goals/${goalId}/check-ins` && init?.method === "POST") return Promise.resolve(Response.json({ ok: true, data: saved }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "报告阻碍" }));
  await user.click(screen.getByRole("radio", { name: "时间不足" }));
  await user.click(screen.getByRole("button", { name: "请教练帮我分析" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("阻碍记录已经保存，但重新读取正式状态失败");
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);

  await user.click(screen.getByRole("button", { name: "重新读取正式状态" }));
  expect(await screen.findByRole("button", { name: "继续请求教练分析" })).toBeEnabled();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
  await user.click(screen.getByRole("button", { name: "仅保留已保存的阻碍记录" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "继续请求教练分析" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "开始这个任务" })).toBeEnabled();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
});

it("rejects a replan without calling the agent and preserves the current milestones", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000217";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const draft = pendingReplan();
  const reviewingGoal = { ...baseGoal, agentState: "plan_review" as const };
  const activeGoal = { ...baseGoal, version: 6 };
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewingGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: executionWorkspace({
        goal: goalReads === 1 ? reviewingGoal : activeGoal,
        pendingDrafts: goalReads === 1 ? [draft] : [],
      }) }));
    }
    if (url === `/api/goals/${goalId}/plan-drafts/${draft.id}/reject` && init?.method === "POST") {
      return Promise.resolve(Response.json({ ok: true, data: { draftId: draft.id, status: "rejected", goal: activeGoal } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "继续使用当前计划（草案 1 / 目标 5）" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "比较两版计划" })).not.toBeInTheDocument());
  expect(screen.getByRole("list", { name: "当前计划里程碑" })).toHaveTextContent("掌握基础类型完成网页交互验证数据保留");
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
  const body = JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/reject"))?.[1]?.body));
  expect(body).toEqual({ expectedDraftVersion: 1, expectedGoalVersion: 5, operationId });
});

it("rejects then explicitly requests a revised proposal with fresh authority", async () => {
  const user = userEvent.setup();
  const rejectId = "43000000-0000-4000-8000-000000000218";
  const turnId = "43000000-0000-4000-8000-000000000219";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(rejectId).mockReturnValueOnce(turnId);
  const firstDraft = pendingReplan();
  const secondDraft = {
    ...pendingReplan(),
    id: "43000000-0000-4000-8000-000000000220",
    payload: { ...pendingReplan().payload, base: { planVersionId: planId, goalVersion: 6 }, changeReason: "根据修改要求重新调整" },
  };
  const reviewingGoal = { ...baseGoal, agentState: "plan_review" as const };
  const activeGoal = { ...baseGoal, version: 6 };
  const revisedGoal = { ...baseGoal, version: 7, agentState: "plan_review" as const };
  let rejected = false;
  let revised = false;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewingGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      const data = revised
        ? executionWorkspace({ goal: revisedGoal, pendingDrafts: [secondDraft] })
        : rejected
          ? executionWorkspace({ goal: activeGoal, pendingDrafts: [] })
          : executionWorkspace({ goal: reviewingGoal, pendingDrafts: [firstDraft] });
      return Promise.resolve(Response.json({ ok: true, data }));
    }
    if (url === `/api/goals/${goalId}/plan-drafts/${firstDraft.id}/reject`) {
      rejected = true;
      return Promise.resolve(Response.json({ ok: true, data: { draftId: firstDraft.id, status: "rejected", goal: activeGoal } }));
    }
    if (url === "/api/agent/turn") {
      revised = true;
      return Promise.resolve(Response.json({ ok: true, data: {
        message: "已重新提出调整方案。", state: "plan_review", draftId: secondDraft.id, persistedChange: true,
        usage: { inputTokens: 10, outputTokens: 8, modelCalls: 1, toolCalls: 1 },
      } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "要求修改（草案 1 / 目标 5）" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(true));
  const turnBody = JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === "/api/agent/turn")?.[1]?.body));
  expect(turnBody).toEqual({ goalId, message: "请重新提出调整方案。", requestOperationId: turnId, explicitIntent: true });
  expect(await screen.findByText("根据修改要求重新调整")).toBeInTheDocument();
});

it("keeps paused replan review actionable without allowing an agent revision request", async () => {
  const user = userEvent.setup();
  const rejectId = "43000000-0000-4000-8000-000000000221";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(rejectId);
  const draft = pendingReplan();
  const pausedGoal = { ...baseGoal, status: "paused" as const, agentState: "paused" as const };
  const refreshedGoal = { ...pausedGoal, version: 6 };
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(pausedGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: executionWorkspace({ goal: goalReads === 1 ? pausedGoal : refreshedGoal, pendingDrafts: goalReads === 1 ? [draft] : [] }) }));
    }
    if (url.endsWith("/reject")) return Promise.resolve(Response.json({ ok: true, data: { draftId: draft.id, status: "rejected", goal: refreshedGoal } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByRole("button", { name: "要求修改（草案 1 / 目标 5）" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "批准新计划（草案 1 / 目标 5）" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "继续使用当前计划（草案 1 / 目标 5）" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "比较两版计划" })).not.toBeInTheDocument());
  expect(screen.getByText("已暂停")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
});

it("adopts the reviewed milestone order only after approving the replan", async () => {
  const user = userEvent.setup();
  const operationId = "43000000-0000-4000-8000-000000000222";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const originalDraft = pendingReplan();
  const draft = { ...originalDraft, payload: { ...originalDraft.payload, milestones: ["完成网页交互", "掌握基础类型", "验证数据保留"] } };
  const reviewingGoal = { ...baseGoal, agentState: "plan_review" as const };
  const successorPlan = {
    ...currentPlan,
    id: "43000000-0000-4000-8000-000000000223",
    number: 2,
    milestones: draft.payload.milestones,
    diff: { ...draft.payload.diff, revision: { ...currentPlan.diff.revision, draftArtifactId: draft.id, payload: draft.payload } },
  };
  const approvedGoal = { ...baseGoal, version: 6, currentPlanVersionId: successorPlan.id };
  const approvalPlan: Record<string, unknown> = { ...successorPlan };
  delete approvalPlan.milestones;
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(reviewingGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) {
      goalReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: executionWorkspace({
        goal: goalReads === 1 ? reviewingGoal : approvedGoal,
        currentPlan: goalReads === 1 ? currentPlan : successorPlan,
        pendingDrafts: goalReads === 1 ? [draft] : [],
      }) }));
    }
    if (url === "/api/approvals") return Promise.resolve(Response.json({ ok: true, data: { plan: approvalPlan, tasks: [executionTask] } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  expect(await screen.findByRole("list", { name: "当前计划里程碑" })).toHaveTextContent("掌握基础类型完成网页交互验证数据保留");
  await user.click(screen.getByRole("button", { name: "批准新计划（草案 1 / 目标 5）" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "比较两版计划" })).not.toBeInTheDocument());
  expect(screen.getByRole("list", { name: "当前计划里程碑" })).toHaveTextContent("完成网页交互掌握基础类型验证数据保留");
});

it("refreshes and explains a version refusal without claiming only a draft changed", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("43000000-0000-4000-8000-000000000224");
  const draft = pendingReplan();
  const current = executionWorkspace({ goal: { ...baseGoal, agentState: "plan_review" }, pendingDrafts: [draft] });
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [summary(current.goal as typeof baseGoal)] }));
    if (url === `/api/goals/${goalId}` && !init?.method) return Promise.resolve(Response.json({ ok: true, data: current }));
    if (url.endsWith("/reject")) return Promise.resolve(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "private" } }, { status: 409 }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalWorkspace goalId={goalId} />);

  await user.click(await screen.findByRole("button", { name: "继续使用当前计划（草案 1 / 目标 5）" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前数据版本已变化，已刷新；请核对后重试。");
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
});
