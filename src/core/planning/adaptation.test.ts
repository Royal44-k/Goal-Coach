import { describe, expect, it } from "vitest";

import type { CheckIn, Goal, Task } from "@/core/domain/contracts";

import { derivePreferenceSignals, detectReplanTriggers } from "./adaptation";
import { estimateBias } from "./progress";

const ownerId = "50000000-0000-4000-8000-000000000010";
const goalId = "50000000-0000-4000-8000-000000000011";

const goal: Goal = {
  id: goalId,
  ownerId,
  title: "学习目标",
  category: "learning",
  status: "active",
  agentState: "active",
  clarificationCount: 0,
  currentPlanVersionId: "50000000-0000-4000-8000-000000000012",
  desiredOutcome: "掌握主题",
  definitionOfDone: "完成练习",
  deadline: "2026-09-10",
  weeklyMinutes: 140,
  constraints: [],
  motivation: "工作需要",
  createdAt: "2026-09-01T09:00:00+08:00",
  updatedAt: "2026-09-01T09:00:00+08:00",
  version: 1,
};

const baseTask: Task = {
  id: "50000000-0000-4000-8000-000000000001",
  ownerId,
  goalId,
  planVersionId: "50000000-0000-4000-8000-000000000012",
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
    id: `50000000-0000-4000-8000-${idSuffix.padStart(12, "0")}`,
    ...overrides,
  };
}

const baseCheckIn: CheckIn = {
  withdrawnAt: null,
  id: "50000000-0000-4000-8000-000000000020",
  ownerId,
  goalId,
  taskId: null,
  kind: "progress",
  blockerCategory: null,
  note: "记录",
  minutesSpent: null,
  availableWeeklyMinutes: null,
  createdAt: "2026-09-03T09:00:00+08:00",
  updatedAt: "2026-09-03T09:00:00+08:00",
  version: 1,
};

function checkIn(idSuffix: string, overrides: Partial<CheckIn> = {}): CheckIn {
  return {
    ...baseCheckIn,
    id: `50000000-0000-4000-8000-${idSuffix.padStart(12, "0")}`,
    ...overrides,
  };
}

describe("detectReplanTriggers", () => {
  it("triggers at the larger actual-overrun threshold boundary", () => {
    const below = task("1", { estimateMinutes: 20, actualMinutes: 34 });
    const atBoundary = task("2", { estimateMinutes: 20, actualMinutes: 35 });
    const ratioBoundary = task("3", { estimateMinutes: 60, actualMinutes: 90 });

    const result = detectReplanTriggers({
      goal,
      tasks: [below, atBoundary, ratioBoundary],
      checkIns: [],
      taskEvents: [],
      now: "2026-09-04T09:00:00+08:00",
    });

    expect(result).toContainEqual({ code: "actual_overrun", taskId: atBoundary.id });
    expect(result).toContainEqual({ code: "actual_overrun", taskId: ratioBoundary.id });
    expect(result).not.toContainEqual({ code: "actual_overrun", taskId: below.id });
  });

  it("triggers after two task-skipped audit projections for the same task", () => {
    const skipped = task("1");
    const result = detectReplanTriggers({
      goal,
      tasks: [skipped],
      checkIns: [],
      taskEvents: [
        { type: "task_skipped", entityId: skipped.id, createdAt: "2026-09-02T09:00:00+08:00" },
        { type: "task_updated", entityId: skipped.id, createdAt: "2026-09-02T10:00:00+08:00" },
        { type: "task_skipped", entityId: skipped.id, createdAt: "2026-09-03T09:00:00+08:00" },
      ],
      now: "2026-09-04T09:00:00+08:00",
    });

    expect(result).toContainEqual({ code: "repeated_skip", taskId: skipped.id });
  });

  it("compares remaining work with weekly capacity prorated to deadline day-end", () => {
    const result = detectReplanTriggers({
      goal: { ...goal, deadline: "2026-09-10", weeklyMinutes: 140 },
      tasks: [task("1", { estimateMinutes: 131 }), task("2", { estimateMinutes: 20, status: "done" })],
      checkIns: [],
      taskEvents: [],
      now: "2026-09-04T12:00:00+08:00",
    });
    expect(result).toContainEqual({ code: "capacity_overload" });

    const exactlyOneDay = detectReplanTriggers({
      goal: { ...goal, deadline: "2026-09-04", weeklyMinutes: 140 },
      tasks: [task("1", { estimateMinutes: 19 })],
      checkIns: [],
      taskEvents: [],
      now: "2026-09-04T00:00:00+08:00",
    });
    expect(exactlyOneDay).not.toContainEqual({ code: "capacity_overload" });
  });

  it("triggers when a structured availability check-in lowers weekly minutes", () => {
    const lowerAvailability = checkIn("1", {
      kind: "availability_change",
      availableWeeklyMinutes: 100,
      note: null,
    });
    expect(
      detectReplanTriggers({
        goal,
        tasks: [],
        checkIns: [lowerAvailability],
        taskEvents: [],
        now: "2026-09-04T09:00:00+08:00",
      }),
    ).toContainEqual({ code: "availability_reduced" });
  });

  it("only treats a structured blocker as unresolved while its current formal task is blocked", () => {
    const blocked = task("1", { status: "blocked" });
    const resolved = task("2", { status: "todo" });
    const oldTaskId = "50000000-0000-4000-8000-000000000099";
    const checkIns = [
      checkIn("1", {
        kind: "blocker",
        taskId: blocked.id,
        blockerCategory: "missing_resource",
      }),
      checkIn("2", {
        kind: "blocker",
        taskId: resolved.id,
        blockerCategory: "prerequisite_incomplete",
      }),
      checkIn("3", {
        kind: "blocker",
        taskId: oldTaskId,
        blockerCategory: "missing_resource",
      }),
      checkIn("4", {
        kind: "blocker",
        taskId: null,
        blockerCategory: "missing_resource",
      }),
      checkIn("5", {
        kind: "blocker",
        taskId: blocked.id,
        blockerCategory: "fear_of_error",
      }),
    ];

    const result = detectReplanTriggers({
      goal,
      tasks: [blocked, resolved],
      checkIns,
      taskEvents: [],
      now: "2026-09-04T09:00:00+08:00",
    });

    expect(result.filter((trigger) => trigger.code === "unresolved_blocker")).toEqual([
      { code: "unresolved_blocker", taskId: blocked.id },
    ]);
  });

  it.each([
    "invalid",
    "2026-09-04T09:00:00",
    "2026-09-04 09:00:00+08:00",
    "2026-02-30T09:00:00+08:00",
  ])("rejects invalid or offset-less now: %s", (now) => {
    expect(() =>
      detectReplanTriggers({ goal, tasks: [], checkIns: [], taskEvents: [], now }),
    ).toThrow("now must be a valid ISO date-time with an explicit offset");
  });
});

describe("derivePreferenceSignals", () => {
  it("keeps tiny positive completed-task median bias persistably positive", () => {
    expect(estimateBias(1, 300)).toBe(1 / 300);
    expect(derivePreferenceSignals([
      task("1", { status: "done", estimateMinutes: 300, actualMinutes: 1 }),
    ], []).estimateBias).toBe(0.01);
  });

  it("derives median bias, granularity, and top-three structured blocker categories", () => {
    const tasks = [
      task("1", { status: "done", estimateMinutes: 20, actualMinutes: 10 }),
      task("2", { status: "done", estimateMinutes: 40, actualMinutes: 49 }),
      task("3", { status: "done", estimateMinutes: 80, actualMinutes: 160 }),
      task("4", { status: "todo", estimateMinutes: 5, actualMinutes: null }),
    ];
    const checkIns = [
      checkIn("1", { kind: "blocker", blockerCategory: "insufficient_time" }),
      checkIn("2", { kind: "blocker", blockerCategory: "missing_resource" }),
      checkIn("3", { kind: "blocker", blockerCategory: "insufficient_time" }),
      checkIn("4", { kind: "blocker", blockerCategory: "fear_of_error" }),
      checkIn("5", { kind: "blocker", blockerCategory: "task_too_large" }),
      checkIn("6", { kind: "blocker", blockerCategory: "missing_resource" }),
      checkIn("7", { kind: "progress", blockerCategory: null, note: "自由文本不推断偏好" }),
    ];

    expect(derivePreferenceSignals(tasks, checkIns)).toEqual({
      estimateBias: 1.23,
      taskGranularity: "medium",
      commonBlockers: ["insufficient_time", "missing_resource", "fear_of_error"],
    });
  });

  it("returns null medians and no blockers without completed or structured blocker data", () => {
    expect(derivePreferenceSignals([task("1")], [checkIn("1")])).toEqual({
      estimateBias: null,
      taskGranularity: null,
      commonBlockers: [],
    });
  });

  it.each([
    [30, "small"],
    [31, "medium"],
    [60, "medium"],
    [61, "large"],
  ] as const)("maps a %i-minute completed-task median to %s granularity", (minutes, expected) => {
    expect(
      derivePreferenceSignals(
        [task("1", { status: "done", estimateMinutes: minutes, actualMinutes: minutes })],
        [],
      ).taskGranularity,
    ).toBe(expected);
  });
});
