import { describe, expect, it } from "vitest";

import type { Task } from "@/core/domain/contracts";

import { findDependencyCycle, getExecutableTasks } from "./dependencies";

const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "20000000-0000-4000-8000-000000000003";

const baseTask: Task = {
  id: A,
  ownerId: "20000000-0000-4000-8000-000000000010",
  goalId: "20000000-0000-4000-8000-000000000011",
  planVersionId: "20000000-0000-4000-8000-000000000012",
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

describe("findDependencyCycle", () => {
  it("returns the first closed dependency path found by depth-first traversal", () => {
    expect(
      findDependencyCycle([
        task({ id: A, dependencyIds: [B] }),
        task({ id: B, dependencyIds: [A] }),
      ]),
    ).toEqual([A, B, A]);
  });

  it("returns a nested cycle from its cycle entry rather than the traversal root", () => {
    expect(
      findDependencyCycle([
        task({ id: A, dependencyIds: [B] }),
        task({ id: B, dependencyIds: [C] }),
        task({ id: C, dependencyIds: [B] }),
      ]),
    ).toEqual([B, C, B]);
  });

  it("returns null for acyclic and unknown dependency references", () => {
    expect(
      findDependencyCycle([
        task({ id: A, dependencyIds: [B] }),
        task({ id: B, dependencyIds: [C] }),
      ]),
    ).toBeNull();
  });
});

describe("getExecutableTasks", () => {
  it("keeps todo and doing tasks with only done dependencies in original order", () => {
    const done = task({ id: A, status: "done" });
    const todo = task({ id: B, dependencyIds: [A], status: "todo" });
    const doing = task({ id: C, dependencyIds: [A], status: "doing" });

    expect(getExecutableTasks([done, todo, doing])).toEqual([todo, doing]);
  });

  it("excludes blocked, completed, skipped, incomplete-dependency, and missing-dependency tasks", () => {
    const done = task({ id: A, status: "done" });
    const pending = task({ id: B, status: "todo" });
    const missingId = "20000000-0000-4000-8000-000000000099";

    expect(
      getExecutableTasks([
        done,
        pending,
        task({ id: C, status: "blocked" }),
        task({ id: "20000000-0000-4000-8000-000000000004", status: "skipped" }),
        task({ id: "20000000-0000-4000-8000-000000000005", dependencyIds: [B] }),
        task({ id: "20000000-0000-4000-8000-000000000006", dependencyIds: [missingId] }),
      ]),
    ).toEqual([pending]);
  });
});
