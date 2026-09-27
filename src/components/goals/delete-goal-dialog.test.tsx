// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DeleteGoalDialog } from "./delete-goal-dialog";

afterEach(cleanup);

it("requires the exact goal title before deletion", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(<DeleteGoalDialog title="完成 TypeScript 练习" version={7} disabled={false} onCancel={vi.fn()} onConfirm={onConfirm} />);
  const button = screen.getByRole("button", { name: "确认删除目标（目标 7）" });
  expect(button).toBeDisabled();
  await user.type(screen.getByLabelText("输入目标标题确认删除"), "完成 TypeScript 练习");
  expect(button).toBeEnabled();
  await user.click(button);
  expect(onConfirm).toHaveBeenCalledWith("完成 TypeScript 练习");
});
