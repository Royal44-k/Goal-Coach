// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TaskEditor } from "./task-editor";

const ids = [
  "55000000-0000-4000-8000-000000000001",
  "55000000-0000-4000-8000-000000000002",
  "55000000-0000-4000-8000-000000000003",
];
const common = {
  ownerId: "55000000-0000-4000-8000-000000000010", goalId: "55000000-0000-4000-8000-000000000011",
  planVersionId: "55000000-0000-4000-8000-000000000012", doneCriteria: "可核对", evidenceType: "text" as const,
  estimateMinutes: 30, actualMinutes: null, dueAt: null, dependencyIds: [], status: "todo" as const,
  createdAt: "2026-09-17T08:00:00+08:00", updatedAt: "2026-09-17T08:00:00+08:00", version: 1,
};
const tasks = ids.map((id, index) => ({ ...common, id, title: `任务 ${index + 1}`, action: `行动 ${index + 1}` }));

afterEach(cleanup);

it("submits a complete proposed list with an edited action and a new temporary task key", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("55000000-0000-4000-8000-000000000099");
  render(<TaskEditor tasks={tasks} disabled={false} onCancel={vi.fn()} onSubmit={onSubmit} />);

  await user.clear(screen.getByLabelText("行动：任务 1"));
  await user.type(screen.getByLabelText("行动：任务 1"), "修改后的行动");
  await user.click(screen.getByRole("button", { name: "添加任务" }));
  await user.type(screen.getByLabelText("标题：新任务 4"), "新增任务");
  await user.type(screen.getByLabelText("行动：新增任务"), "完成新增工作");
  await user.type(screen.getByLabelText("完成标准：新增任务"), "新增工作可核对");
  await user.type(screen.getByLabelText("修改原因"), "调整执行步骤");
  await user.click(screen.getByRole("button", { name: "生成计划草案并审阅" }));

  expect(onSubmit).toHaveBeenCalledOnce();
  const proposal = onSubmit.mock.calls[0][0];
  expect(proposal.changeReason).toBe("调整执行步骤");
  expect(proposal.tasks).toHaveLength(4);
  expect(proposal.tasks[0]).toMatchObject({ id: ids[0], action: "修改后的行动" });
  expect(proposal.tasks[3]).toMatchObject({ id: "55000000-0000-4000-8000-000000000099", title: "新增任务", action: "完成新增工作" });
});
