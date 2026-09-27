// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PreferenceControls } from "./preference-controls";

afterEach(cleanup);

const preference = {
  id: "76000000-0000-4000-8000-000000000001",
  ownerId: "76000000-0000-4000-8000-000000000002",
  taskGranularity: "medium" as const,
  preferredTimeWindow: "工作日晚间",
  estimateBias: 1.4,
  commonBlockers: ["insufficient_time" as const],
  effectiveStrategies: ["先做最小步骤"],
  createdAt: "2026-09-17T08:00:00+08:00",
  updatedAt: "2026-09-17T08:00:00+08:00",
  version: 3,
};

it("separates derived signals from the two editable preference fields", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(<PreferenceControls preference={preference} disabled={false} onSave={onSave} onClear={vi.fn()} />);

  expect(screen.getByText("任务粒度 中等")).toBeInTheDocument();
  expect(screen.getByText("估时偏差 1.40×")).toBeInTheDocument();
  expect(screen.getByText("常见阻碍 时间不足")).toBeInTheDocument();
  await user.clear(screen.getByLabelText("偏好时间段"));
  await user.type(screen.getByLabelText("偏好时间段"), " 周末上午 ");
  await user.clear(screen.getByLabelText("有效策略（每行一条）"));
  await user.type(screen.getByLabelText("有效策略（每行一条）"), "先列清单\n关闭通知");
  await user.click(screen.getByRole("button", { name: "保存教练偏好（偏好 3）" }));

  expect(onSave).toHaveBeenCalledWith({ preferredTimeWindow: "周末上午", effectiveStrategies: ["先列清单", "关闭通知"] });
});

it("clears only coach preferences through an explicit action", async () => {
  const user = userEvent.setup();
  const onClear = vi.fn();
  render(<PreferenceControls preference={preference} disabled={false} onSave={vi.fn()} onClear={onClear} />);
  await user.click(screen.getByRole("button", { name: "清除教练偏好" }));
  expect(onClear).toHaveBeenCalledTimes(1);
});

it("rejects preference drafts beyond the canonical bounds", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(<PreferenceControls preference={preference} disabled={false} onSave={onSave} onClear={vi.fn()} />);
  await user.clear(screen.getByLabelText("偏好时间段"));
  await user.type(screen.getByLabelText("偏好时间段"), "x".repeat(121));
  await user.click(screen.getByRole("button", { name: "保存教练偏好（偏好 3）" }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("偏好时间段最多 120 个字符");
});
