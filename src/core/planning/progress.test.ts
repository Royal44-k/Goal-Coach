import { describe, expect, it } from "vitest";

import type { Task } from "@/core/domain/contracts";

import { calculateProgress, estimateBias } from "./progress";

const baseTask: Task = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000002",
  goalId: "10000000-0000-4000-8000-000000000003",
  planVersionId: "10000000-0000-4000-8000-000000000004",
  title: "任务",
  action: "执行任务",
  doneCriteria: "任务完成",
  evidenceType: "user_declaration",
  estimateMinutes: 20,
  actualMinutes: null,
  dueAt: null,
  dependencyIds: [],
  status: "todo",
  createdAt: "2026-09-01T09:00:00+08:00",
  updatedAt: "2026-09-01T09:00:00+08:00",
  version: 1,
};

function task(overrides: Partial<Task>): Task {
  return { ...baseTask, ...overrides };
}

describe("calculateProgress", () => {
  it("counts done tasks while excluding skipped tasks from the denominator", () => {
    expect(
      calculateProgress([
        task({ status: "done" }),
        task({ status: "todo" }),
        task({ status: "skipped" }),
      ]),
    ).toEqual({ completed: 1, total: 2, percent: 50 });
  });

  it("returns zero percent when every task is skipped", () => {
    expect(calculateProgress([task({ status: "skipped" })])).toEqual({
      completed: 0,
      total: 0,
      percent: 0,
    });
  });

  it("rounds a non-integral completion percentage to the nearest whole percent", () => {
    expect(
      calculateProgress([
        task({ status: "done" }),
        task({ status: "todo" }),
        task({ status: "blocked" }),
      ]).percent,
    ).toBe(33);
  });
});

describe("estimateBias", () => {
  it("returns the actual-to-estimate ratio", () => {
    expect(estimateBias(45, 30)).toBe(1.5);
  });

  it.each([
    [null, 30],
    [45, null],
    [0, 30],
    [45, 0],
    [undefined, 30],
  ])("returns null when actual %s or estimate %s is absent or zero", (actual, estimate) => {
    expect(estimateBias(actual, estimate)).toBeNull();
  });
});
