import type {
  AuditEvent,
  BlockerCategory,
  CheckIn,
  Goal,
  Task,
  UserPreference,
} from "@/core/domain/contracts";

import { calendarDayEndInstant, parseCalendarNow } from "./calendar";

const WEEK_IN_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export type TaskStatusAuditProjection = Pick<AuditEvent, "type" | "entityId" | "createdAt">;

export type ReplanTriggerCode =
  | "actual_overrun"
  | "repeated_skip"
  | "capacity_overload"
  | "availability_reduced"
  | "unresolved_blocker";

export type ReplanTrigger = {
  code: ReplanTriggerCode;
  taskId?: string;
};

export type DetectReplanTriggersInput = {
  goal: Goal;
  tasks: readonly Task[];
  checkIns: readonly CheckIn[];
  taskEvents: readonly TaskStatusAuditProjection[];
  now: string;
};

export type PreferenceSignals = {
  estimateBias: number | null;
  taskGranularity: UserPreference["taskGranularity"] | null;
  commonBlockers: BlockerCategory[];
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function detectReplanTriggers(input: DetectReplanTriggersInput): ReplanTrigger[] {
  const { instant, offsetMinutes } = parseCalendarNow(input.now);
  const triggers: ReplanTrigger[] = [];

  for (const task of input.tasks) {
    const threshold = Math.max(task.estimateMinutes * 1.5, task.estimateMinutes + 15);
    if (task.actualMinutes !== null && task.actualMinutes >= threshold) {
      triggers.push({ code: "actual_overrun", taskId: task.id });
    }
  }

  const skipCounts = new Map<string, number>();
  for (const event of input.taskEvents) {
    if (event.type === "task_skipped") {
      skipCounts.set(event.entityId, (skipCounts.get(event.entityId) ?? 0) + 1);
    }
  }
  for (const [taskId, count] of skipCounts) {
    if (count >= 2) {
      triggers.push({ code: "repeated_skip", taskId });
    }
  }

  if (input.goal.deadline !== null && input.goal.weeklyMinutes !== null) {
    const deadlineEnd = calendarDayEndInstant(input.goal.deadline, offsetMinutes);
    if (deadlineEnd > instant) {
      const remainingMinutes = input.tasks
        .filter((task) => task.status !== "done" && task.status !== "skipped")
        .reduce((total, task) => total + task.estimateMinutes, 0);
      const proratedCapacity =
        input.goal.weeklyMinutes * ((deadlineEnd - instant) / WEEK_IN_MILLISECONDS);
      if (remainingMinutes > proratedCapacity) {
        triggers.push({ code: "capacity_overload" });
      }
    }
  }

  const weeklyMinutes = input.goal.weeklyMinutes;
  if (
    weeklyMinutes !== null &&
    input.checkIns.some(
      (checkIn) =>
        checkIn.kind === "availability_change" &&
        checkIn.availableWeeklyMinutes !== null &&
        checkIn.availableWeeklyMinutes < weeklyMinutes,
    )
  ) {
    triggers.push({ code: "availability_reduced" });
  }

  const blockedTaskIds = new Set(
    input.tasks.filter((task) => task.status === "blocked").map((task) => task.id),
  );
  const unresolvedTaskIds = new Set<string>();
  for (const checkIn of input.checkIns) {
    if (
      checkIn.kind === "blocker" &&
      checkIn.taskId !== null &&
      blockedTaskIds.has(checkIn.taskId) &&
      (checkIn.blockerCategory === "missing_resource" ||
        checkIn.blockerCategory === "prerequisite_incomplete")
    ) {
      unresolvedTaskIds.add(checkIn.taskId);
    }
  }
  for (const task of input.tasks) {
    if (unresolvedTaskIds.has(task.id)) {
      triggers.push({ code: "unresolved_blocker", taskId: task.id });
    }
  }

  return triggers;
}

export function derivePreferenceSignals(
  tasks: readonly Task[],
  checkIns: readonly CheckIn[],
): PreferenceSignals {
  const completedTasks = tasks.filter((task) => task.status === "done");
  const biasMedian = median(
    completedTasks.flatMap((task) =>
      task.actualMinutes === null || task.actualMinutes === 0
        ? []
        : [task.actualMinutes / task.estimateMinutes],
    ),
  );
  const estimateMedian = median(completedTasks.map((task) => task.estimateMinutes));

  let taskGranularity: UserPreference["taskGranularity"] | null = null;
  if (estimateMedian !== null) {
    taskGranularity = estimateMedian <= 30 ? "small" : estimateMedian <= 60 ? "medium" : "large";
  }

  const blockerCounts = new Map<BlockerCategory, { count: number; firstIndex: number }>();
  checkIns.forEach((checkIn, index) => {
    if (checkIn.kind !== "blocker" || checkIn.blockerCategory === null) {
      return;
    }
    const current = blockerCounts.get(checkIn.blockerCategory);
    blockerCounts.set(checkIn.blockerCategory, {
      count: (current?.count ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index,
    });
  });

  const commonBlockers = [...blockerCounts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].firstIndex - right[1].firstIndex)
    .slice(0, 3)
    .map(([category]) => category);

  return {
    estimateBias: biasMedian === null ? null : Math.max(0.01, Math.round(biasMedian * 100) / 100),
    taskGranularity,
    commonBlockers,
  };
}
