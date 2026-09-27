import { describe, expect, it } from "vitest";

import type { Task } from "@/core/domain/contracts";

import { chooseNextAction } from "./next-action";

const baseTask: Task = {
  id: "30000000-0000-4000-8000-000000000001",
  ownerId: "30000000-0000-4000-8000-000000000010",
  goalId: "30000000-0000-4000-8000-000000000011",
  planVersionId: "30000000-0000-4000-8000-000000000012",
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
    id: `30000000-0000-4000-8000-${idSuffix.padStart(12, "0")}`,
    ...overrides,
  };
}

describe("chooseNextAction", () => {
  it("selects the overdue executable task before lower-ranked candidates", () => {
    const prerequisite = task("1", { status: "done" });
    const urgentUnblockedTask = task("2", {
      dependencyIds: [prerequisite.id],
      dueAt: "2026-09-03",
      estimateMinutes: 15,
    });
    const blockedTask = task("3", { status: "blocked", dueAt: "2026-09-02", estimateMinutes: 10 });

    const result = chooseNextAction({
      tasks: [prerequisite, blockedTask, urgentUnblockedTask],
      availableMinutes: 20,
      now: "2026-09-04T09:00:00+08:00",
    });

    expect(result?.task).toBe(urgentUnblockedTask);
    expect(result?.suggestedSliceMinutes).toBe(15);
    expect(result?.reasons).toContain("已逾期");
  });

  it("treats today's calendar deadline as inclusive at both ends of the day", () => {
    const today = task("1", { dueAt: "2026-09-04" });
    const overdue = task("2", { dueAt: "2026-09-03" });

    for (const now of ["2026-09-04T00:00:00+08:00", "2026-09-04T23:59:59.999+08:00"]) {
      const result = chooseNextAction({ tasks: [today, overdue], availableMinutes: 30, now });
      expect(result?.task.id).toBe(overdue.id);
      expect(result?.reasons).toContain("已逾期");
    }

    expect(
      chooseNextAction({ tasks: [today], availableMinutes: 30, now: "2026-09-04T00:00:00+08:00" })
        ?.reasons,
    ).not.toContain("已逾期");
  });

  it("uses the due-day end instant for the exact 24-hour rank across offsets", () => {
    const exactBoundary = task("1", { dueAt: "2026-09-05" });
    const later = task("2", { dueAt: "2026-09-06" });

    const result = chooseNextAction({
      tasks: [later, exactBoundary],
      availableMinutes: 30,
      now: "2026-09-04T23:59:59.999+08:00",
    });
    expect(result?.task.id).toBe(exactBoundary.id);
    expect(result?.reasons).toContain("24 小时内到期");

    const sameInstantDifferentOffset = chooseNextAction({
      tasks: [exactBoundary],
      availableMinutes: 30,
      now: "2026-09-04T15:59:59.999Z",
    });
    expect(sameInstantDifferentOffset?.reasons).not.toContain("24 小时内到期");
  });

  it("uses fit, due date, then original order after urgency ranks", () => {
    const tooLarge = task("1", { estimateMinutes: 40, dueAt: "2026-09-10" });
    const fitsLater = task("2", { estimateMinutes: 20, dueAt: "2026-09-12" });
    expect(
      chooseNextAction({
        tasks: [tooLarge, fitsLater],
        availableMinutes: 20,
        now: "2026-09-04T09:00:00+08:00",
      })?.task.id,
    ).toBe(fitsLater.id);

    const early = task("3", { estimateMinutes: 10, dueAt: "2026-09-08" });
    const late = task("4", { estimateMinutes: 10, dueAt: "2026-09-09" });
    expect(
      chooseNextAction({
        tasks: [late, early],
        availableMinutes: 20,
        now: "2026-09-04T09:00:00+08:00",
      })?.task.id,
    ).toBe(early.id);

    const first = task("5", { estimateMinutes: 10, dueAt: null });
    const second = task("6", { estimateMinutes: 10, dueAt: null });
    expect(
      chooseNextAction({
        tasks: [first, second],
        availableMinutes: 20,
        now: "2026-09-04T09:00:00+08:00",
      })?.task.id,
    ).toBe(first.id);
  });

  it("bounds the suggested slice to 5 through 30 minutes", () => {
    expect(
      chooseNextAction({
        tasks: [task("1", { estimateMinutes: 90 })],
        availableMinutes: 60,
        now: "2026-09-04T09:00:00+08:00",
      })?.suggestedSliceMinutes,
    ).toBe(30);
    expect(
      chooseNextAction({
        tasks: [task("2", { estimateMinutes: 2 })],
        availableMinutes: 2,
        now: "2026-09-04T09:00:00+08:00",
      })?.suggestedSliceMinutes,
    ).toBe(5);
  });

  it("returns null when every formal task is dependency-ineligible", () => {
    expect(
      chooseNextAction({
        tasks: [task("1", { dependencyIds: ["30000000-0000-4000-8000-000000000099"] })],
        availableMinutes: 20,
        now: "2026-09-04T09:00:00+08:00",
      }),
    ).toBeNull();
  });

  it.each([
    "not-a-date",
    "2026-09-04T09:00:00",
    "2026-09-04 09:00:00+08:00",
    "2026-02-30T09:00:00+08:00",
  ])("rejects invalid or offset-less now: %s", (now) => {
    expect(() => chooseNextAction({ tasks: [], availableMinutes: 20, now })).toThrow(
      "now must be a valid ISO date-time with an explicit offset",
    );
  });
});
