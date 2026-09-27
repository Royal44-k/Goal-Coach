// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BlockerDialog } from "./blocker-dialog";

const task = {
  id: "55000000-0000-4000-8000-000000000001",
  ownerId: "55000000-0000-4000-8000-000000000002",
  goalId: "55000000-0000-4000-8000-000000000003",
  planVersionId: "55000000-0000-4000-8000-000000000004",
  title: "拆分第一个可执行步骤",
  action: "列出最小步骤",
  doneCriteria: "得到一条可立即执行的步骤",
  evidenceType: "text" as const,
  estimateMinutes: 20,
  actualMinutes: null,
  dueAt: null,
  dependencyIds: [],
  status: "blocked" as const,
  createdAt: "2026-09-17T08:00:00+08:00",
  updatedAt: "2026-09-17T08:00:00+08:00",
  version: 1,
};

afterEach(cleanup);

it("submits one of the six canonical categories with a verbatim optional note", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<BlockerDialog task={task} disabled={false} onCancel={vi.fn()} onSubmit={onSubmit} />);

  expect(screen.getByText(`这次记录关联任务：${task.title}`)).toBeInTheDocument();
  expect(screen.getAllByRole("radio")).toHaveLength(6);
  await user.click(screen.getByRole("radio", { name: "任务太大，不知道怎么开始" }));
  await user.type(screen.getByLabelText("补充说明（选填）"), "只有二十分钟");
  await user.click(screen.getByRole("button", { name: "请教练帮我分析" }));

  expect(onSubmit).toHaveBeenCalledWith({
    taskId: task.id,
    blockerCategory: "task_too_large",
    note: "只有二十分钟",
    minutesSpent: null,
    availableWeeklyMinutes: null,
  });
});

it("normalizes a blank note to null and explicitly labels a goal-level report", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<BlockerDialog task={null} disabled={false} onCancel={vi.fn()} onSubmit={onSubmit} />);

  expect(screen.getByText("这次记录关联整个目标，不指定任务。")).toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "缺少资源或信息" }));
  await user.type(screen.getByLabelText("补充说明（选填）"), "   ");
  await user.click(screen.getByRole("button", { name: "请教练帮我分析" }));

  expect(onSubmit).toHaveBeenCalledWith({
    taskId: null,
    blockerCategory: "missing_resource",
    note: null,
    minutesSpent: null,
    availableWeeklyMinutes: null,
  });
});
