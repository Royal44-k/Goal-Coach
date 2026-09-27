// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DataControls } from "./data-controls";

afterEach(cleanup);

it("enables full clear only for the exact confirmation phrase", async () => {
  const user = userEvent.setup();
  const onClear = vi.fn();
  render(<DataControls settingId="76000000-0000-4000-8000-000000000010" disabled={false} deletedCounts={null} onExport={vi.fn()} onClear={onClear} />);

  const clear = screen.getByRole("button", { name: "永久清除全部本地数据" });
  expect(clear).toBeDisabled();
  expect(screen.getByText(/绑定当前本机设置 76000000-0000-4000-8000-000000000010/)).toBeInTheDocument();
  await user.type(screen.getByLabelText("输入确认短语"), "清除我的全部本地数据");
  expect(clear).toBeEnabled();
  await user.click(clear);
  expect(onClear).toHaveBeenCalledWith("清除我的全部本地数据");
});

it("shows confirmed deleted counts and local allowance reset disclosure", () => {
  render(<DataControls settingId="76000000-0000-4000-8000-000000000010" disabled={false} deletedCounts={{ goals: 2, tasks: 4, evidence: 1 }} onExport={vi.fn()} onClear={vi.fn()} />);
  expect(screen.getByText("目标：2")).toBeInTheDocument();
  expect(screen.getByText("任务：4")).toBeInTheDocument();
  expect(screen.getByText(/本机每日模型用量记录也已重置/)).toBeInTheDocument();
});
