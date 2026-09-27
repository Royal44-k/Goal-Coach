// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { UndoBanner } from "./undo-banner";

afterEach(cleanup);

it("requests the goal-scoped undo and explains evidence retention", async () => {
  const user = userEvent.setup();
  const onUndo = vi.fn();
  render(<UndoBanner disabled={false} label="最近一次阻碍反馈" unavailableReason={null} onUndo={onUndo} />);

  expect(screen.getByText(/不会删除已经提交的历史证据/)).toBeInTheDocument();
  expect(screen.getByText("最近一次阻碍反馈")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "撤销上一次修改" }));
  expect(onUndo).toHaveBeenCalledOnce();
});
it("shows why the latest change cannot be undone without offering an earlier change", () => {
  render(<UndoBanner disabled label="任务：旧计划" unavailableReason="最近修改属于历史计划，不能撤销。" onUndo={() => { throw new Error("must not run"); }} />);
  expect(screen.getByRole("button", { name: "撤销上一次修改" })).toBeDisabled();
  expect(screen.getByText("最近修改属于历史计划，不能撤销。")).toBeInTheDocument();
});
