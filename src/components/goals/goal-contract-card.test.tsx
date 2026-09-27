// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { GoalContractCard } from "./goal-contract-card";

const goalId = "41000000-0000-4000-8000-000000000001";
const draftId = "41000000-0000-4000-8000-000000000002";
const savedDraftId = "41000000-0000-4000-8000-000000000003";
const operationId = "41000000-0000-4000-8000-000000000004";
const now = "2026-09-16T08:00:00+08:00";
const goal = {
  id: goalId, ownerId: "41000000-0000-4000-8000-000000000009", createdAt: now, updatedAt: now,
  version: 2, title: "TypeScript", category: "learning" as const, status: "draft" as const,
  agentState: "contract_review" as const, clarificationCount: 1, currentPlanVersionId: null,
  desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null,
  constraints: null, motivation: null,
};
const contract = {
  title: "TypeScript", category: "learning" as const, desiredOutcome: "完成待办网页",
  definitionOfDone: "可以新增、完成和删除任务", deadline: "2026-10-14", weeklyMinutes: 420,
  constraints: ["仅使用本机"], motivation: "掌握类型系统",
};
const draft = {
  id: draftId, ownerId: goal.ownerId, goalId, kind: "goal_contract" as const,
  payload: { schemaVersion: 2 as const, baseGoalVersion: 2, contract, assumptions: [
    { field: "deadline" as const, reason: "暂定日期，等待你确认。" },
  ] },
  contentHash: "a".repeat(64), status: "pending" as const, createdAt: now, updatedAt: now, version: 1,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps edits local, disables approval, then replaces the displayed versions with the full contract", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const saved = {
    ...draft,
    id: savedDraftId,
    version: 3,
    payload: {
      ...draft.payload,
      baseGoalVersion: 3,
      contract: { ...contract, desiredOutcome: "完成可持久化的待办网页" },
      assumptions: [{ field: "deadline" as const, reason: "服务端保留的暂定日期说明。" }],
    },
  };
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: saved }));
  vi.stubGlobal("fetch", fetchMock);
  const onDraftSaved = vi.fn().mockResolvedValue(saved);
  render(<GoalContractCard goal={goal} draft={draft} onRefresh={vi.fn()} onDraftSaved={onDraftSaved} onApproved={vi.fn()} />);

  expect(screen.getByText("草案版本 1 · 目标版本 2")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "编辑目标契约" }));
  const outcome = screen.getByLabelText("期望成果");
  await user.clear(outcome);
  await user.type(outcome, "完成可持久化的待办网页");

  expect(screen.getByRole("button", { name: "批准目标契约（草案 1 / 目标 2）" })).toBeDisabled();
  expect(goal.desiredOutcome).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存草案（基于草案 1 / 目标 2）" }));

  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    draftId,
    expectedDraftVersion: 1,
    expectedGoalVersion: 2,
    contract: { ...contract, desiredOutcome: "完成可持久化的待办网页" },
    operationId,
  });
  expect(await screen.findByText("草案版本 3 · 目标版本 3")).toBeInTheDocument();
  expect(screen.getByText(/服务端保留的暂定日期说明/)).toBeInTheDocument();
  expect(onDraftSaved).toHaveBeenCalledWith(saved);
});

it("never approves an incomplete saved contract and directs the user to complete it manually", () => {
  render(<GoalContractCard
    goal={goal}
    draft={{ ...draft, payload: { ...draft.payload, contract: { ...contract, definitionOfDone: null } } }}
    onRefresh={vi.fn()}
    onDraftSaved={vi.fn()}
    onApproved={vi.fn()}
  />);

  expect(screen.getByRole("button", { name: "批准目标契约（草案 1 / 目标 2）" })).toBeDisabled();
  expect(screen.getByText("请手动补全期望成果和完成标准后再批准。")).toBeInTheDocument();
});

it("bootstraps a manual draft from nullable formal fields without calling the agent", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const manualGoal = { ...goal, version: 1, agentState: "clarifying" as const, title: "整理资料" };
  const saved = {
    ...draft,
    id: savedDraftId,
    goalId: manualGoal.id,
    payload: {
      ...draft.payload,
      baseGoalVersion: 2,
      contract: {
        title: "整理资料", category: "learning" as const, desiredOutcome: "文件有序",
        definitionOfDone: "三个目录均已归类", deadline: "2026-10-14", weeklyMinutes: 60,
        constraints: [], motivation: "减少查找时间",
      },
      assumptions: [],
    },
  };
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: saved }));
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalContractCard goal={manualGoal} draft={null} onRefresh={vi.fn()} onDraftSaved={vi.fn()} onApproved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "手动填写目标" }));
  const form = screen.getByRole("form", { name: "目标契约" });
  await user.type(within(form).getByLabelText("期望成果"), "文件有序");
  await user.type(within(form).getByLabelText("完成标准"), "三个目录均已归类");
  await user.type(within(form).getByLabelText("截止日期"), "2026-10-14");
  await user.clear(within(form).getByLabelText("每周投入分钟"));
  await user.type(within(form).getByLabelText("每周投入分钟"), "60");
  await user.type(within(form).getByLabelText("动机"), "减少查找时间");
  await user.click(within(form).getByRole("button", { name: "保存草案（基于目标 1）" }));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(`/api/goals/${manualGoal.id}/contract-drafts`);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toEqual({
    expectedGoalVersion: 1,
    contract: {
      title: "整理资料", category: "learning", desiredOutcome: "文件有序",
      definitionOfDone: "三个目录均已归类", deadline: "2026-10-14", weeklyMinutes: 60,
      constraints: [], motivation: "减少查找时间",
    },
    operationId,
  });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
});

it("locks fresh contract approval while an unknown result can only replay its original body", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError("lost approval response"))
    .mockResolvedValueOnce(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "private" } }, { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalContractCard goal={goal} draft={draft} onRefresh={vi.fn().mockResolvedValue(undefined)} onDraftSaved={vi.fn()} onApproved={vi.fn()} />);

  const approveButton = screen.getByRole("button", { name: "批准目标契约（草案 1 / 目标 2）" });
  await user.click(approveButton);
  expect(await screen.findByRole("button", { name: "查询批准结果" })).toBeEnabled();
  expect(approveButton).toBeDisabled();
  expect(screen.getByRole("button", { name: "编辑目标契约" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /保存草案/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "查询批准结果" }));

  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
    { goalId, draftId, toolName: "save_approved_contract", expectedDraftVersion: 1, operationId },
    { goalId, draftId, toolName: "save_approved_contract", expectedDraftVersion: 1, operationId },
  ]);
});

it("locks fresh contract saves while an unknown result can only replay its original body", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError("lost save response"))
    .mockResolvedValueOnce(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "private" } }, { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalContractCard goal={goal} draft={draft} onRefresh={vi.fn().mockResolvedValue(undefined)} onDraftSaved={vi.fn()} onApproved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "编辑目标契约" }));
  const outcome = screen.getByLabelText("期望成果");
  await user.clear(outcome);
  await user.type(outcome, "保留原保存正文");
  const saveButton = screen.getByRole("button", { name: "保存草案（基于草案 1 / 目标 2）" });
  await user.click(saveButton);
  expect(await screen.findByRole("button", { name: "查询保存结果" })).toBeEnabled();
  expect(saveButton).toBeDisabled();

  await user.clear(outcome);
  await user.type(outcome, "后来编辑的文字");
  await user.click(screen.getByRole("button", { name: "查询保存结果" }));
  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    draftId,
    expectedDraftVersion: 1,
    expectedGoalVersion: 2,
    contract: { desiredOutcome: "保留原保存正文" },
    operationId,
  });
});

it("never approves a historical save replay and adopts only a later authoritative draft", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const historicalReplay = {
    ...draft,
    id: savedDraftId,
    payload: {
      ...draft.payload,
      contract: { ...contract, desiredOutcome: "历史保存响应" },
    },
  };
  const authoritativeDraft = {
    ...draft,
    id: "41000000-0000-4000-8000-000000000008",
    version: 4,
    payload: {
      ...draft.payload,
      baseGoalVersion: 3,
      contract: { ...contract, desiredOutcome: "当前权威草案" },
      assumptions: [],
    },
  };
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: historicalReplay }));
  const onDraftSaved = vi.fn()
    .mockRejectedValueOnce(new Error("authoritative read failed"))
    .mockResolvedValueOnce(authoritativeDraft);
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalContractCard goal={goal} draft={draft} onRefresh={vi.fn()} onDraftSaved={onDraftSaved} onApproved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "编辑目标契约" }));
  const outcome = screen.getByLabelText("期望成果");
  await user.clear(outcome);
  await user.type(outcome, "历史保存响应");
  await user.click(screen.getByRole("button", { name: "保存草案（基于草案 1 / 目标 2）" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("草案已经保存，但重新读取目标状态失败");
  expect(screen.getByText("草案版本 1 · 目标版本 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "批准目标契约（草案 1 / 目标 2）" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存草案（基于草案 1 / 目标 2）" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));

  expect(await screen.findByText("草案版本 4 · 目标版本 3")).toBeInTheDocument();
  expect(screen.getByText("当前权威草案")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "批准目标契约（草案 4 / 目标 3）" })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onDraftSaved).toHaveBeenNthCalledWith(1, historicalReplay);
  expect(onDraftSaved).toHaveBeenNthCalledWith(2, historicalReplay);
});

it("reports a post-success refresh failure without relabeling contract approval as unknown", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: {
    goal: { ...goal, version: 3, agentState: "planning" },
  } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<GoalContractCard
    goal={goal}
    draft={draft}
    onRefresh={vi.fn()}
    onDraftSaved={vi.fn()}
    onApproved={vi.fn().mockRejectedValue(new Error("refresh failed"))}
  />);

  await user.click(screen.getByRole("button", { name: "批准目标契约（草案 1 / 目标 2）" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("目标契约已经批准，但重新读取目标状态失败");
  expect(screen.queryByRole("button", { name: "查询批准结果" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
