// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GoalList } from "./goal-list";

const goalSummary = {
  id: "8d6ab7e8-d538-4dd6-a5e8-c65b981d9550",
  title: "完成 TypeScript 待办网页",
  category: "learning" as const,
  status: "active" as const,
  agentState: "active" as const,
  updatedAt: "2026-09-16T08:00:00+08:00",
  progress: { completed: 1, total: 3, percent: 33 },
};

afterEach(cleanup);

it("links every goal to its workspace and gives progress a text alternative", () => {
  render(<GoalList goals={[goalSummary]} />);

  expect(screen.getByRole("link", { name: goalSummary.title })).toHaveAttribute("href", `/goals/${goalSummary.id}`);
  expect(screen.getByText("已完成 1 / 3 项（33%）")).toBeInTheDocument();
});

it("turns the empty state into a clear first action", () => {
  render(<GoalList goals={[]} />);

  expect(screen.getByRole("heading", { name: "还没有目标" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "创建第一个目标" })).toHaveAttribute("href", "/goals/new");
});
