// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PlanReviewCard } from "./plan-review-card";

const goalId = "42000000-0000-4000-8000-000000000001";
const draftId = "42000000-0000-4000-8000-000000000002";
const operationId = "42000000-0000-4000-8000-000000000003";
const taskIds = [
  "42000000-0000-4000-8000-000000000011",
  "42000000-0000-4000-8000-000000000012",
  "42000000-0000-4000-8000-000000000013",
];
const tasks = taskIds.map((id, index) => ({
  id,
  title: `任务 ${index + 1}`,
  action: `执行行动 ${index + 1}`,
  doneCriteria: `完成标准 ${index + 1}`,
  evidenceType: "text" as const,
  estimateMinutes: 60,
  dueAt: `2026-10-${String(index + 10).padStart(2, "0")}`,
  dependencyIds: index === 0 ? [] : [taskIds[index - 1]],
}));
const now = "2026-09-16T08:00:00+08:00";
const draft = {
  id: draftId,
  ownerId: "42000000-0000-4000-8000-000000000099",
  goalId,
  kind: "plan" as const,
  payload: {
    schemaVersion: 2 as const,
    milestones: ["掌握基础类型", "完成交互", "验证持久化"],
    base: { planVersionId: null, goalVersion: 4 },
    changeReason: null,
    changeSource: "agent" as const,
    tasks,
    executionResets: [],
    diff: { added: taskIds, removed: [], moved: [], changed: [] },
  },
  contentHash: "b".repeat(64),
  status: "pending" as const,
  createdAt: now,
  updatedAt: now,
  version: 2,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders sealed milestones before tasks and approves only the visible draft binding", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: {
    plan: {
      id: "42000000-0000-4000-8000-000000000020", ownerId: draft.ownerId, goalId, number: 1,
      status: "approved", changeReason: null, changeSource: "agent", diff: {
        added: taskIds, removed: [], moved: [], changed: [], revision: {
          schemaVersion: 2, draftArtifactId: draftId, draftArtifactVersion: 2, payload: draft.payload,
          taskMap: tasks.map((task, index) => ({ draftKey: task.id, sourceTaskId: null, storedTaskId: `42000000-0000-4000-8000-00000000002${index + 1}` })),
          evidenceMap: [],
        },
      }, approvedAt: now, createdAt: now, updatedAt: now, version: 1,
    },
    tasks: [],
  } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard goalId={goalId} draft={draft} onRefresh={vi.fn()} onApproved={vi.fn()} />);

  const cardText = screen.getByRole("region", { name: "计划草案" }).textContent ?? "";
  expect(cardText.indexOf("掌握基础类型")).toBeLessThan(cardText.indexOf("任务 1"));
  expect(screen.getByRole("heading", { name: "新增" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "删除" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "顺序变化" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "内容变化" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));

  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toEqual({
    goalId,
    draftId,
    toolName: "save_approved_plan",
    expectedDraftVersion: 2,
    operationId,
  });
  expect(body).not.toHaveProperty("contentHash");
  expect(body).not.toHaveProperty("ownerId");
});

it("refreshes after a received approval error without automatically approving again", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "VERSION_CONFLICT", message: "私有服务细节" },
  }, { status: 409 }));
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard goalId={goalId} draft={draft} onRefresh={onRefresh} onApproved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("草案已变化，请重新审阅");
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("locks fresh approval ids during unknown outcome and replays the original body", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError("lost approval response"))
    .mockResolvedValueOnce(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "private" } }, { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard goalId={goalId} draft={draft} onRefresh={vi.fn().mockResolvedValue(undefined)} onApproved={vi.fn()} />);

  const approveButton = screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" });
  await user.click(approveButton);
  expect(await screen.findByRole("button", { name: "查询批准结果" })).toBeEnabled();
  expect(approveButton).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "查询批准结果" }));

  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
    { goalId, draftId, toolName: "save_approved_plan", expectedDraftVersion: 2, operationId },
    { goalId, draftId, toolName: "save_approved_plan", expectedDraftVersion: 2, operationId },
  ]);
});

it("reports a post-success refresh failure without relabeling approval as unknown", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: {
    plan: {
      id: "42000000-0000-4000-8000-000000000020", ownerId: draft.ownerId, goalId, number: 1,
      status: "approved", changeReason: null, changeSource: "agent", diff: {
        added: taskIds, removed: [], moved: [], changed: [], revision: {
          schemaVersion: 2, draftArtifactId: draftId, draftArtifactVersion: 2, payload: draft.payload,
          taskMap: tasks.map((task, index) => ({ draftKey: task.id, sourceTaskId: null, storedTaskId: `42000000-0000-4000-8000-00000000002${index + 1}` })), evidenceMap: [],
        },
      }, approvedAt: now, createdAt: now, updatedAt: now, version: 1,
    }, tasks: [],
  } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard goalId={goalId} draft={draft} onRefresh={vi.fn()} onApproved={vi.fn().mockRejectedValue(new Error("refresh failed"))} />);

  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("计划已经批准，但重新读取目标状态失败");
  expect(screen.queryByRole("button", { name: "查询批准结果" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("unlocks a fresh approval only after refresh-failed received result is reconciled", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "VERSION_CONFLICT", message: "private" },
  }, { status: 409 }));
  const onRefresh = vi.fn()
    .mockRejectedValueOnce(new Error("refresh failed"))
    .mockResolvedValueOnce(undefined);
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard goalId={goalId} draft={draft} onRefresh={onRefresh} onApproved={vi.fn()} />);

  const approveButton = screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" });
  await user.click(approveButton);
  expect(await screen.findByRole("button", { name: "重新读取目标状态" })).toBeEnabled();
  expect(approveButton).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("草案已变化，请重新审阅");
  expect(approveButton).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps the shared lease while a received-result refresh rejects an overlapping exact replay", async () => {
  const user = userEvent.setup();
  const lease = { owner: "plan_approval" as const, identity: { goalId, generation: 1 }, token: Symbol("approval") };
  let finishRefresh: (() => void) | undefined;
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "VERSION_CONFLICT", message: "private" },
  }, { status: 409 }));
  const onRefresh = vi.fn()
    .mockRejectedValueOnce(new Error("refresh failed"))
    .mockImplementationOnce(() => new Promise<void>(resolve => { finishRefresh = resolve; }))
    .mockResolvedValue(undefined);
  const releaseFreshMutation = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard
    goalId={goalId}
    draft={draft}
    onRefresh={onRefresh}
    onApproved={vi.fn()}
    freshMutationBlocked={false}
    tryAcquireFreshMutation={vi.fn(() => lease)}
    releaseFreshMutation={releaseFreshMutation}
  />);

  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));
  const refresh = await screen.findByRole("button", { name: "重新读取目标状态" });
  const replay = screen.getByRole("button", { name: "查询批准结果" });
  act(() => {
    refresh.click();
    replay.click();
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(releaseFreshMutation).not.toHaveBeenCalled();
  finishRefresh?.();
  await waitFor(() => expect(releaseFreshMutation).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects received-result refresh while an exact approval replay owns recovery", async () => {
  const user = userEvent.setup();
  const lease = { owner: "plan_approval" as const, identity: { goalId, generation: 1 }, token: Symbol("approval") };
  let finishReplay: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "private" } }, { status: 409 }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finishReplay = resolve; }));
  const onRefresh = vi.fn()
    .mockRejectedValueOnce(new Error("refresh failed"))
    .mockResolvedValue(undefined);
  const releaseFreshMutation = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard
    goalId={goalId}
    draft={draft}
    onRefresh={onRefresh}
    onApproved={vi.fn()}
    freshMutationBlocked={false}
    tryAcquireFreshMutation={vi.fn(() => lease)}
    releaseFreshMutation={releaseFreshMutation}
  />);

  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));
  const refresh = await screen.findByRole("button", { name: "重新读取目标状态" });
  const replay = screen.getByRole("button", { name: "查询批准结果" });
  act(() => {
    replay.click();
    refresh.click();
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(releaseFreshMutation).not.toHaveBeenCalled();
  finishReplay?.(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "private" } }, { status: 409 }));
  await waitFor(() => expect(releaseFreshMutation).toHaveBeenCalledTimes(1));
  expect(onRefresh).toHaveBeenCalledTimes(2);
});

it("serializes repeated known-success refreshes without another approval POST", async () => {
  const user = userEvent.setup();
  const lease = { owner: "plan_approval" as const, identity: { goalId, generation: 1 }, token: Symbol("approval") };
  let finishRefresh: (() => void) | undefined;
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: {
    plan: {
      id: "42000000-0000-4000-8000-000000000020", ownerId: draft.ownerId, goalId, number: 1,
      status: "approved", changeReason: null, changeSource: "agent", diff: {
        added: taskIds, removed: [], moved: [], changed: [], revision: {
          schemaVersion: 2, draftArtifactId: draftId, draftArtifactVersion: 2, payload: draft.payload,
          taskMap: tasks.map((task, index) => ({ draftKey: task.id, sourceTaskId: null, storedTaskId: `42000000-0000-4000-8000-00000000002${index + 1}` })), evidenceMap: [],
        },
      }, approvedAt: now, createdAt: now, updatedAt: now, version: 1,
    }, tasks: [],
  } }));
  const onApproved = vi.fn()
    .mockRejectedValueOnce(new Error("refresh failed"))
    .mockImplementationOnce(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
  const releaseFreshMutation = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard
    goalId={goalId}
    draft={draft}
    onRefresh={vi.fn()}
    onApproved={onApproved}
    freshMutationBlocked={false}
    tryAcquireFreshMutation={vi.fn(() => lease)}
    releaseFreshMutation={releaseFreshMutation}
  />);

  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));
  const refresh = await screen.findByRole("button", { name: "重新读取目标状态" });
  act(() => {
    refresh.click();
    refresh.click();
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onApproved).toHaveBeenCalledTimes(2);
  expect(releaseFreshMutation).not.toHaveBeenCalled();
  finishRefresh?.();
  await waitFor(() => expect(releaseFreshMutation).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("admits only one fresh approval before React renders the running state", () => {
  const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal("fetch", fetchMock);
  render(<PlanReviewCard goalId={goalId} draft={draft} onRefresh={vi.fn()} onApproved={vi.fn()} />);

  const approve = screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" });
  act(() => {
    approve.click();
    approve.click();
  });

  expect(uuid).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("acquires the shared fresh-mutation lease before allocating an approval id", async () => {
  const user = userEvent.setup();
  const order: string[] = [];
  const lease = { owner: "plan_approval" as const, identity: { goalId, generation: 1 }, token: Symbol("approval") };
  const tryAcquireFreshMutation = vi.fn(() => { order.push("acquire"); return lease; });
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => { order.push("uuid"); return operationId; });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("lost response")));
  render(<PlanReviewCard
    goalId={goalId}
    draft={draft}
    onRefresh={vi.fn()}
    onApproved={vi.fn()}
    freshMutationBlocked={false}
    tryAcquireFreshMutation={tryAcquireFreshMutation}
    releaseFreshMutation={vi.fn()}
  />);

  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));

  expect(order).toEqual(["acquire", "uuid"]);
  expect(tryAcquireFreshMutation).toHaveBeenCalledWith("plan_approval");
  expect(await screen.findByRole("button", { name: "查询批准结果" })).toBeEnabled();
});

it("honors an execution-owned shared lock without allocating a fresh approval id", async () => {
  const tryAcquireFreshMutation = vi.fn();
  const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
  render(<PlanReviewCard
    goalId={goalId}
    draft={draft}
    onRefresh={vi.fn()}
    onApproved={vi.fn()}
    freshMutationBlocked={true}
    tryAcquireFreshMutation={tryAcquireFreshMutation}
    releaseFreshMutation={vi.fn()}
  />);

  expect(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" })).toBeDisabled();
  expect(tryAcquireFreshMutation).not.toHaveBeenCalled();
  expect(uuid).not.toHaveBeenCalled();
});

it("does not invoke old-goal approval reconciliation after the card changes goals", async () => {
  const user = userEvent.setup();
  const lease = { owner: "plan_approval" as const, identity: { goalId, generation: 1 }, token: Symbol("approval") };
  let finishApproval: ((response: Response) => void) | undefined;
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finishApproval = resolve; })));
  const onApproved = vi.fn();
  const releaseFreshMutation = vi.fn();
  const view = render(<PlanReviewCard
    goalId={goalId}
    draft={draft}
    onRefresh={vi.fn()}
    onApproved={onApproved}
    freshMutationBlocked={false}
    tryAcquireFreshMutation={vi.fn(() => lease)}
    releaseFreshMutation={releaseFreshMutation}
  />);

  await user.click(screen.getByRole("button", { name: "批准计划（草案 2 / 目标 4）" }));
  const otherGoalId = "42000000-0000-4000-8000-000000000090";
  view.rerender(<PlanReviewCard
    goalId={otherGoalId}
    draft={{ ...draft, goalId: otherGoalId }}
    onRefresh={vi.fn()}
    onApproved={onApproved}
    freshMutationBlocked={false}
    tryAcquireFreshMutation={vi.fn(() => null)}
    releaseFreshMutation={releaseFreshMutation}
  />);
  finishApproval?.(Response.json({ ok: true, data: {
    plan: {
      id: "42000000-0000-4000-8000-000000000020", ownerId: draft.ownerId, goalId, number: 1,
      status: "approved", changeReason: null, changeSource: "agent", diff: {
        added: taskIds, removed: [], moved: [], changed: [], revision: {
          schemaVersion: 2, draftArtifactId: draftId, draftArtifactVersion: 2, payload: draft.payload,
          taskMap: tasks.map((task, index) => ({ draftKey: task.id, sourceTaskId: null, storedTaskId: `42000000-0000-4000-8000-00000000002${index + 1}` })), evidenceMap: [],
        },
      }, approvedAt: now, createdAt: now, updatedAt: now, version: 1,
    }, tasks: [],
  } }));
  await Promise.resolve();
  await Promise.resolve();

  expect(onApproved).not.toHaveBeenCalled();
  expect(releaseFreshMutation).not.toHaveBeenCalled();
});

it("identifies a received version conflict as a changed draft that must be reviewed again", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "VERSION_CONFLICT", message: "private conflict detail" },
  }, { status: 409 })));
  render(<PlanReviewCard
    goalId={goalId}
    draft={draft}
    onRefresh={vi.fn().mockResolvedValue(undefined)}
    onApproved={vi.fn()}
    approvalLabel="批准新计划"
  />);

  await user.click(screen.getByRole("button", { name: "批准新计划（草案 2 / 目标 4）" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("草案已变化，请重新审阅");
});
