import type { CheckIn, Goal } from "@/core/domain/contracts";
import { calendarDayEndInstant, parseCalendarNow } from "./calendar";

const WEEK_IN_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

/** Uniform-rate planning estimate, not a promise of calendar availability. */
export function remainingPlanningCapacity(
  goal: Pick<Goal, "deadline" | "weeklyMinutes">,
  checkIns: readonly Pick<CheckIn, "kind" | "availableWeeklyMinutes" | "withdrawnAt">[],
  now: string,
): { effectiveWeeklyMinutes: number; estimatedRemainingMinutes: number } | null {
  if (goal.deadline === null || goal.weeklyMinutes === null) return null;
  const { instant } = parseCalendarNow(now);
  const weekly = checkIns.findLast(checkIn => checkIn.withdrawnAt === null
    && checkIn.kind === "availability_change" && checkIn.availableWeeklyMinutes !== null)
    ?.availableWeeklyMinutes ?? goal.weeklyMinutes;
  const deadlineEnd = calendarDayEndInstant(goal.deadline, 8 * 60);
  const estimatedRemainingMinutes = Math.floor(weekly * Math.max(0, deadlineEnd - instant) / WEEK_IN_MILLISECONDS);
  return { effectiveWeeklyMinutes: weekly, estimatedRemainingMinutes };
}
