// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DeleteTaskDialog } from "./delete-task-dialog";

const task = {
  id: "54000000-0000-4000-8000-000000000001", ownerId: "54000000-0000-4000-8000-000000000002",
  goalId: "54000000-0000-4000-8000-000000000003", planVersionId: "54000000-0000-4000-8000-000000000004",
  title: "删除这一项", action: "删除", doneCriteria: "已删除", evidenceType: "user_declaration" as const,
  estimateMinutes: 10, actualMinutes: null, dueAt: null, dependencyIds: [], status: "todo" as const,
  createdAt: "2026-09-17T08:00:00+08:00", updatedAt: "2026-09-17T08:00:00+08:00", version: 3,
};

afterEach(cleanup);

it("requires the exact displayed task title and explains retained history", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(<DeleteTaskDialog task={task} dependentTasks={[]} disabled={false} onCancel={vi.fn()} onConfirm={onConfirm} />);

  expect(screen.getByText(/历史版本仍会保留/)).toBeInTheDocument();
  const input = screen.getByLabelText(`输入任务标题“${task.title}”确认删除`);
  await user.type(input, `${task.title} `);
  expect(screen.getByRole("button", { name: "确认删除任务" })).toBeDisabled();
  await user.clear(input);
  await user.type(input, task.title);
  await user.click(screen.getByRole("button", { name: "确认删除任务" }));
  expect(onConfirm).toHaveBeenCalledWith(task, task.title);
});

it("blocks deletion when a current task depends on it and directs structural review", () => {
  render(<DeleteTaskDialog task={task} dependentTasks={[{ ...task, id: "54000000-0000-4000-8000-000000000010", title: "依赖任务" }]} disabled={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByText(/先在计划编辑中调整依赖并完成审阅/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认删除任务" })).toBeDisabled();
});
