import { expect, it } from "vitest";
import { remainingPlanningCapacity } from "./remaining-capacity";
import type { CheckIn, Goal } from "@/core/domain/contracts";

const goal = { deadline: "2026-09-28", weeklyMinutes: 180 } as Goal;
const availability = (minutes: number, withdrawnAt: string | null = null) => ({
  kind: "availability_change", availableWeeklyMinutes: minutes, withdrawnAt,
}) as CheckIn;

it("prorates the latest active availability through Shanghai deadline end", () => {
  const now = "2026-09-21T23:59:59.999+08:00";
  expect(remainingPlanningCapacity(goal, [], now)).toEqual({ effectiveWeeklyMinutes: 180, estimatedRemainingMinutes: 180 });
  expect(remainingPlanningCapacity(goal, [availability(120), availability(90)], now))
    .toEqual({ effectiveWeeklyMinutes: 90, estimatedRemainingMinutes: 90 });
  expect(remainingPlanningCapacity(goal, [availability(120), availability(90, "2026-09-21T00:00:00Z")], now))
    .toEqual({ effectiveWeeklyMinutes: 120, estimatedRemainingMinutes: 120 });
  expect(remainingPlanningCapacity(goal, [availability(120, "2026-09-21T00:00:00Z")], now))
    .toEqual({ effectiveWeeklyMinutes: 180, estimatedRemainingMinutes: 180 });
});

it("uses the Shanghai calendar boundary, returns zero after expiry, and leaves incomplete capacity unknown", () => {
  expect(remainingPlanningCapacity(goal, [], "2026-09-21T15:59:59.999Z")?.estimatedRemainingMinutes).toBe(180);
  expect(remainingPlanningCapacity(goal, [], "2026-09-21T16:00:00.000Z")?.estimatedRemainingMinutes).toBe(179);
  expect(remainingPlanningCapacity(goal, [], "2026-09-28T16:00:00.000Z")?.estimatedRemainingMinutes).toBe(0);
  expect(remainingPlanningCapacity({ ...goal, deadline: null }, [], "2026-09-21T00:00:00Z")).toBeNull();
  expect(remainingPlanningCapacity({ ...goal, weeklyMinutes: null }, [], "2026-09-21T00:00:00Z")).toBeNull();
});
