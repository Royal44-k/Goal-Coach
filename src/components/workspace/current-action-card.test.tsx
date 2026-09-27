// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CurrentActionCard } from "./current-action-card";

const task = {
  id: "51000000-0000-4000-8000-000000000001",
  ownerId: "51000000-0000-4000-8000-000000000002",
  goalId: "51000000-0000-4000-8000-000000000003",
  planVersionId: "51000000-0000-4000-8000-000000000004",
  title: "完成表单交互",
  action: "实现新增和勾选任务",
  doneCriteria: "三个交互均可键盘完成",
  evidenceType: "text" as const,
  estimateMinutes: 45,
  actualMinutes: null,
  dueAt: "2026-09-18",
  dependencyIds: [],
  status: "todo" as const,
  createdAt: "2026-09-17T08:00:00+08:00",
  updatedAt: "2026-09-17T08:00:00+08:00",
  version: 1,
};

afterEach(cleanup);

it("renders the server suggestion without claiming the user supplied availability", () => {
  render(<CurrentActionCard result={{ task, suggestedSliceMinutes: 30, reasons: ["按30分钟起步窗口推荐"] }} disabled={false} onStart={vi.fn()} onBlocked={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "现在最值得做" })).toBeInTheDocument();
  expect(screen.getByText(task.action)).toBeInTheDocument();
  expect(screen.getByText("建议先做 30 分钟")).toBeInTheDocument();
  expect(screen.getByText("按30分钟起步窗口推荐")).toBeInTheDocument();
  expect(screen.queryByText(/你有30分钟|你提供了30分钟/)).not.toBeInTheDocument();
});

it("starts the formal suggested task and reports its blocker", async () => {
  const user = userEvent.setup();
  const onStart = vi.fn();
  const onBlocked = vi.fn();
  render(<CurrentActionCard result={{ task, suggestedSliceMinutes: 30, reasons: ["按30分钟起步窗口推荐"] }} disabled={false} onStart={onStart} onBlocked={onBlocked} />);

  await user.click(screen.getByRole("button", { name: "开始这个任务" }));
  await user.click(screen.getByRole("button", { name: "我卡住了" }));

  expect(onStart).toHaveBeenCalledWith(task);
  expect(onBlocked).toHaveBeenCalledWith(task);
});

it("shows a truthful empty action state", () => {
  const { rerender } = render(<CurrentActionCard result={null} hasBlockedTasks={true} disabled={false} onStart={vi.fn()} onBlocked={vi.fn()} />);
  expect(screen.getByText("先解决阻塞")).toBeInTheDocument();

  rerender(<CurrentActionCard result={null} hasBlockedTasks={false} disabled={false} onStart={vi.fn()} onBlocked={vi.fn()} />);
  expect(screen.getByText("当前计划没有待执行任务")).toBeInTheDocument();
});
