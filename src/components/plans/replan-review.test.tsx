// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ReplanReview } from "./replan-review";

const now = "2026-09-17T08:00:00+08:00";
const goalId = "56000000-0000-4000-8000-000000000001";
const planId = "56000000-0000-4000-8000-000000000002";
const taskId = "56000000-0000-4000-8000-000000000003";
const payload = {
  schemaVersion: 2 as const,
  milestones: ["完成网页交互", "掌握基础类型", "验证数据保留"],
  base: { planVersionId: planId, goalVersion: 8 },
  changeReason: "连续两次跳过同一任务",
  changeSource: "agent" as const,
  tasks: [{
    id: taskId,
    title: "实现待办交互",
    action: "先用 5 分钟列出一个最小步骤，再继续：实现新增与勾选",
    doneCriteria: "新增与勾选可用",
    evidenceType: "text" as const,
    estimateMinutes: 45,
    dueAt: null,
    dependencyIds: [],
  }],
  executionResets: [],
  diff: { added: [], removed: [], moved: [taskId], changed: [taskId] },
};
const draft = {
  id: "56000000-0000-4000-8000-000000000004",
  ownerId: "56000000-0000-4000-8000-000000000099",
  goalId,
  kind: "replan" as const,
  payload,
  contentHash: "a".repeat(64),
  status: "pending" as const,
  createdAt: now,
  updatedAt: now,
  version: 3,
};
const currentPlan = {
  id: planId,
  ownerId: draft.ownerId,
  goalId,
  number: 2,
  status: "approved" as const,
  changeReason: null,
  changeSource: "agent" as const,
  diff: {
    added: [], removed: [], moved: [], changed: [],
    revision: {
      schemaVersion: 2 as const,
      draftArtifactId: "56000000-0000-4000-8000-000000000005",
      draftArtifactVersion: 1,
      payload: { ...payload, milestones: ["掌握基础类型", "完成网页交互", "验证数据保留"] },
      taskMap: [], evidenceMap: [],
    },
  },
  approvedAt: now,
  createdAt: now,
  updatedAt: now,
  version: 1,
  milestones: ["掌握基础类型", "完成网页交互", "验证数据保留"],
};

afterEach(cleanup);

it("keeps the current plan labelled active and compares ordered milestone lists before approval", () => {
  render(<ReplanReview
    goalId={goalId}
    goalStatus="active"
    goalVersion={9}
    currentPlan={currentPlan}
    draft={draft}
    disabled={false}
    onKeepCurrent={vi.fn()}
    onRequestRevision={vi.fn()}
    onRefresh={vi.fn()}
    onApproved={vi.fn()}
  />);

  expect(screen.getByLabelText("计划版本状态")).toHaveTextContent("当前有效 · 计划第 2 版");
  expect(screen.getByLabelText("计划版本状态")).toHaveTextContent("待批准 · 草案版本 3");
  expect(screen.getByText("教练建议")).toBeInTheDocument();
  expect(screen.getByText("连续两次跳过同一任务")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "当前有效里程碑" })).toHaveTextContent("掌握基础类型完成网页交互验证数据保留");
  expect(screen.getByRole("list", { name: "拟议里程碑" })).toHaveTextContent("完成网页交互掌握基础类型验证数据保留");
  for (const heading of ["新增", "删除", "顺序变化", "内容变化"]) {
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  }
  expect(screen.getByRole("button", { name: "继续使用当前计划（草案 3 / 目标 9）" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "要求修改（草案 3 / 目标 9）" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "批准新计划（草案 3 / 目标 8）" })).toBeEnabled();
});

it("exposes rejection choices as separate user actions and disables revision requests while paused", async () => {
  const user = userEvent.setup();
  const onKeepCurrent = vi.fn();
  const onRequestRevision = vi.fn();
  const view = render(<ReplanReview
    goalId={goalId}
    goalStatus="active"
    goalVersion={9}
    currentPlan={currentPlan}
    draft={draft}
    disabled={false}
    onKeepCurrent={onKeepCurrent}
    onRequestRevision={onRequestRevision}
    onRefresh={vi.fn()}
    onApproved={vi.fn()}
  />);

  await user.click(screen.getByRole("button", { name: "继续使用当前计划（草案 3 / 目标 9）" }));
  expect(onKeepCurrent).toHaveBeenCalledTimes(1);
  expect(onRequestRevision).not.toHaveBeenCalled();

  view.rerender(<ReplanReview
    goalId={goalId}
    goalStatus="paused"
    goalVersion={9}
    currentPlan={currentPlan}
    draft={draft}
    disabled={false}
    onKeepCurrent={onKeepCurrent}
    onRequestRevision={onRequestRevision}
    onRefresh={vi.fn()}
    onApproved={vi.fn()}
  />);
  expect(screen.getByRole("button", { name: "要求修改（草案 3 / 目标 9）" })).toBeDisabled();
  expect(screen.getByText("恢复目标后才能请教练修改；你仍可保留或批准这份草案。")).toBeInTheDocument();
});
