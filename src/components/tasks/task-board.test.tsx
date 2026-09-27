// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TaskBoard } from "./task-board";

const task = {
  id: "52000000-0000-4000-8000-000000000001", ownerId: "52000000-0000-4000-8000-000000000002",
  goalId: "52000000-0000-4000-8000-000000000003", planVersionId: "52000000-0000-4000-8000-000000000004",
  title: "编写工作台", action: "实现当前任务列表", doneCriteria: "可开始、编辑和完成", evidenceType: "text" as const,
  estimateMinutes: 45, actualMinutes: null, dueAt: null, dependencyIds: [], status: "todo" as const,
  createdAt: "2026-09-17T08:00:00+08:00", updatedAt: "2026-09-17T08:00:00+08:00", version: 2,
};

afterEach(cleanup);

it("sends the task id and displayed version for an ordinary status change", async () => {
  const user = userEvent.setup();
  const onStatusChange = vi.fn();
  render(<TaskBoard tasks={[task]} evidence={[]} disabled={false} onStatusChange={onStatusChange} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: `开始：${task.title}` }));
  expect(onStatusChange).toHaveBeenCalledWith(task.id, task.version, "doing");
});

it("disables start for a task whose dependency is not done", () => {
  const dependency = { ...task, id: "52000000-0000-4000-8000-000000000010", title: "前置任务" };
  const blocked = { ...task, id: "52000000-0000-4000-8000-000000000011", title: "后续任务", dependencyIds: [dependency.id] };
  render(<TaskBoard tasks={[dependency, blocked]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} />);

  expect(screen.getByRole("button", { name: `开始：${blocked.title}` })).toBeDisabled();
});

it("opens edit from the keyboard", async () => {
  const user = userEvent.setup();
  const onEdit = vi.fn();
  render(<TaskBoard tasks={[task]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={onEdit} onComplete={vi.fn()} onDelete={vi.fn()} />);

  const edit = screen.getByRole("button", { name: `编辑：${task.title}` });
  edit.focus();
  await user.keyboard("{Enter}");
  expect(onEdit).toHaveBeenCalledWith(task);
});

it("labels retained evidence as history when the task is not done", () => {
  const evidence = [{
    id: "52000000-0000-4000-8000-000000000020", ownerId: task.ownerId, goalId: task.goalId, taskId: task.id,
    type: "text" as const, text: "先前提交的说明", fileName: null, fileSize: null, mimeType: null,
    createdAt: task.createdAt, updatedAt: task.updatedAt, version: 1,
  }];
  render(<TaskBoard tasks={[task]} evidence={evidence} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} />);

  expect(screen.getByText("历史证据（不表示当前已完成）")).toBeInTheDocument();
  expect(screen.getByText("先前提交的说明")).toBeInTheDocument();
});

it("accepts positive minutes or an empty value", async () => {
  const user = userEvent.setup();
  const onMinutesChange = vi.fn();
  const { rerender } = render(<TaskBoard tasks={[{ ...task, actualMinutes: 25 }]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} onMinutesChange={onMinutesChange} />);

  const minutes = screen.getByRole("spinbutton", { name: "实际用时（分钟）" });
  await user.clear(minutes);
  await user.tab();
  expect(onMinutesChange).toHaveBeenLastCalledWith(task.id, task.version, null);

  rerender(<TaskBoard tasks={[task]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} onMinutesChange={onMinutesChange} />);
  const emptyMinutes = screen.getByRole("spinbutton", { name: "实际用时（分钟）" });
  await user.type(emptyMinutes, "1");
  await user.tab();
  expect(onMinutesChange).toHaveBeenLastCalledWith(task.id, task.version, 1);
});

it.each(["0", "-1", "1.5"])("rejects invalid actual minutes %s", async value => {
  const user = userEvent.setup();
  const onMinutesChange = vi.fn();
  render(<TaskBoard tasks={[task]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} onMinutesChange={onMinutesChange} />);

  await user.type(screen.getByRole("spinbutton", { name: "实际用时（分钟）" }), value);
  await user.tab();
  expect(onMinutesChange).not.toHaveBeenCalled();
});

it("replaces a dirty minutes field when an authoritative task version arrives", async () => {
  const user = userEvent.setup();
  const onMinutesChange = vi.fn();
  const { rerender } = render(<TaskBoard tasks={[task]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} onMinutesChange={onMinutesChange} />);

  const minutes = screen.getByRole("spinbutton", { name: "实际用时（分钟）" });
  await user.type(minutes, "25");
  await user.tab();
  expect(onMinutesChange).toHaveBeenCalledTimes(1);
  rerender(<TaskBoard tasks={[{ ...task, actualMinutes: 25, version: 3 }]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} onMinutesChange={onMinutesChange} />);
  rerender(<TaskBoard tasks={[{ ...task, actualMinutes: null, version: 4 }]} evidence={[]} disabled={false} onStatusChange={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onDelete={vi.fn()} onMinutesChange={onMinutesChange} />);

  const authoritativeMinutes = screen.getByRole("spinbutton", { name: "实际用时（分钟）" });
  expect(authoritativeMinutes).toHaveValue(null);
  authoritativeMinutes.focus();
  await user.tab();
  expect(onMinutesChange).toHaveBeenCalledTimes(1);
});
