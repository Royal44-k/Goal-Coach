// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { GoalReview } from "./goal-review";

afterEach(cleanup);

const summary = {
  estimatedMinutes: 90,
  actualMinutes: 115,
  missingActualCount: 0,
  blockers: ["时间不足"],
  strategies: ["先做最小步骤"],
  planChanges: ["第 2 版：根据时间变化调整"],
  reflection: {
    stale: false,
    message: "你完成了全部任务，拆小步骤最有效。",
    generatedAt: "2026-09-17T10:00:00+08:00",
  },
};

it("shows live deterministic review facts separately from the historical generated reflection", () => {
  render(<GoalReview summary={summary} goalVersion={7} disabled={false} onRequestReflection={vi.fn()} onConfirm={vi.fn()} />);

  expect(screen.getByText("预计与实际耗时")).toBeInTheDocument();
  expect(screen.getByText("预计 90 分钟；已记录实际 115 分钟")).toBeInTheDocument();
  expect(screen.getByText("主要阻碍")).toBeInTheDocument();
  expect(screen.getByText("有效策略")).toBeInTheDocument();
  expect(screen.getByText("计划调整记录")).toBeInTheDocument();
  expect(screen.getByText("已保存的生成复盘")).toBeInTheDocument();
  expect(screen.getByText(/可能不包含之后的修改/)).toBeInTheDocument();
});

it("requires an explicit confirmation before completing the goal", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(<GoalReview summary={summary} goalVersion={7} disabled={false} onRequestReflection={vi.fn()} onConfirm={onConfirm} />);

  expect(screen.getByRole("button", { name: "确认完成目标（目标 7）" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /确认已核对当前执行数据/ }));
  await user.click(screen.getByRole("button", { name: "确认完成目标（目标 7）" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("disables reflection generation without model consent while keeping a saved review completable", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(<GoalReview summary={summary} goalVersion={7} disabled={false} requestDisabled onRequestReflection={vi.fn()} onConfirm={onConfirm} />);
  expect(screen.getByRole("button", { name: "重新生成目标复盘" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /确认已核对当前执行数据/ }));
  await user.click(screen.getByRole("button", { name: "确认完成目标（目标 7）" }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("labels a saved reflection historical when feedback was withdrawn", () => {
  render(<GoalReview summary={{ ...summary, blockers: [], reflection: { ...summary.reflection, stale: true } }} goalVersion={8} disabled={false} onRequestReflection={() => {}} onConfirm={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("历史复盘：反馈已撤销，输入数据已变化");
  expect(screen.getByText(summary.reflection.message)).toBeInTheDocument();
  expect(screen.getByText("没有记录阻碍。")).toBeInTheDocument();
});

it("never requests a reflection during rendering and keeps regeneration explicit", async () => {
  const user = userEvent.setup();
  const onRequestReflection = vi.fn();
  render(<GoalReview summary={{ ...summary, reflection: null }} goalVersion={7} disabled={false} onRequestReflection={onRequestReflection} onConfirm={vi.fn()} />);

  expect(onRequestReflection).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "生成目标复盘" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "确认完成目标（目标 7）" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "生成目标复盘" }));
  expect(onRequestReflection).toHaveBeenCalledTimes(1);
});

it("invalidates an old confirmation when the displayed goal snapshot changes", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  const view = render(<GoalReview summary={summary} goalVersion={7} disabled={false} onRequestReflection={vi.fn()} onConfirm={onConfirm} />);
  await user.click(screen.getByRole("checkbox", { name: /确认已核对当前执行数据/ }));
  expect(screen.getByRole("button", { name: "确认完成目标（目标 7）" })).toBeEnabled();

  view.rerender(<GoalReview summary={{ ...summary, actualMinutes: 120 }} goalVersion={8} disabled={false} onRequestReflection={vi.fn()} onConfirm={onConfirm} />);
  expect(screen.getByRole("button", { name: "确认完成目标（目标 8）" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "确认完成目标（目标 8）" }));
  expect(onConfirm).not.toHaveBeenCalled();
});
