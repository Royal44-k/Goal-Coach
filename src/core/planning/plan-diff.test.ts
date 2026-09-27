import { describe, expect, it } from "vitest";

import type { Task } from "@/core/domain/contracts";

import { diffPlans } from "./plan-diff";

const baseTask: Task = {
  id: "40000000-0000-4000-8000-000000000001",
  ownerId: "40000000-0000-4000-8000-000000000010",
  goalId: "40000000-0000-4000-8000-000000000011",
  planVersionId: "40000000-0000-4000-8000-000000000012",
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

function task(idSuffix: string, overrides: Partial<Task> = {}): Task {
  return {
    ...baseTask,
    id: `40000000-0000-4000-8000-${idSuffix.padStart(12, "0")}`,
    ...overrides,
  };
}

describe("diffPlans", () => {
  it("reports added, removed, moved, and user-editable changes in stable plan order", () => {
    const movedTask = task("1");
    const changedTask = task("2");
    const removedTask = task("3");
    const newTask = task("4");

    expect(
      diffPlans(
        [movedTask, changedTask, removedTask],
        [changedTask, task("1", { estimateMinutes: 25 }), newTask],
      ),
    ).toEqual({
      added: [newTask.id],
      removed: [removedTask.id],
      moved: [changedTask.id, movedTask.id],
      changed: [movedTask.id],
    });
  });

  it("ignores persistence, plan-version, and execution-only fields", () => {
    const before = task("1");
    const after = {
      ...before,
      planVersionId: "40000000-0000-4000-8000-000000000099",
      actualMinutes: 25,
      status: "done" as const,
      createdAt: "2026-09-02T09:00:00+08:00",
      updatedAt: "2026-09-03T09:00:00+08:00",
      version: 9,
    };

    expect(diffPlans([before], [after])).toEqual({ added: [], removed: [], moved: [], changed: [] });
  });

  it.each([
    ["title", "新标题"],
    ["action", "新行动"],
    ["doneCriteria", "新完成标准"],
    ["evidenceType", "text"],
    ["estimateMinutes", 45],
    ["dueAt", "2026-09-20"],
    ["dependencyIds", ["40000000-0000-4000-8000-000000000099"]],
  ] as const)("detects a changed %s field", (field, value) => {
    const before = task("1");
    const after = { ...before, [field]: value } as Task;
    expect(diffPlans([before], [after]).changed).toEqual([before.id]);
  });
});
