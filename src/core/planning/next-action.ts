import type { Task } from "@/core/domain/contracts";

import { calendarDayEndInstant, parseCalendarNow } from "./calendar";
import { getExecutableTasks } from "./dependencies";

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

export type NextActionResult = {
  task: Task;
  suggestedSliceMinutes: number;
  reasons: string[];
};

export type ChooseNextActionInput = {
  tasks: readonly Task[];
  availableMinutes: number;
  now: string;
};

type RankedTask = {
  task: Task;
  index: number;
  overdue: boolean;
  dueWithin24Hours: boolean;
  fitsAvailableMinutes: boolean;
  dueEnd: number | null;
};

function rankTasks(input: ChooseNextActionInput): RankedTask[] {
  const { instant, offsetMinutes } = parseCalendarNow(input.now);

  return getExecutableTasks(input.tasks).map((task) => {
    const dueEnd =
      task.dueAt === null ? null : calendarDayEndInstant(task.dueAt, offsetMinutes);
    return {
      task,
      index: input.tasks.indexOf(task),
      overdue: dueEnd !== null && dueEnd < instant,
      dueWithin24Hours:
        dueEnd !== null && dueEnd >= instant && dueEnd <= instant + DAY_IN_MILLISECONDS,
      fitsAvailableMinutes: task.estimateMinutes <= input.availableMinutes,
      dueEnd,
    };
  });
}

export function chooseNextAction(input: ChooseNextActionInput): NextActionResult | null {
  const rankedTasks = rankTasks(input).sort((left, right) => {
    const booleanRanks = [
      Number(right.overdue) - Number(left.overdue),
      Number(right.dueWithin24Hours) - Number(left.dueWithin24Hours),
      Number(right.fitsAvailableMinutes) - Number(left.fitsAvailableMinutes),
    ];
    const decisiveBooleanRank = booleanRanks.find((rank) => rank !== 0);
    if (decisiveBooleanRank !== undefined) {
      return decisiveBooleanRank;
    }

    if (left.dueEnd !== right.dueEnd) {
      if (left.dueEnd === null) return 1;
      if (right.dueEnd === null) return -1;
      return left.dueEnd - right.dueEnd;
    }

    return left.index - right.index;
  });

  const selected = rankedTasks[0];
  if (!selected) {
    return null;
  }

  const reasons: string[] = [];
  if (selected.overdue) reasons.push("已逾期");
  if (selected.dueWithin24Hours) reasons.push("24 小时内到期");
  if (selected.fitsAvailableMinutes) reasons.push("适合当前可用时间");
  if (selected.dueEnd !== null) reasons.push("有明确截止日期");
  if (reasons.length === 0) reasons.push("保持计划顺序");

  return {
    task: selected.task,
    suggestedSliceMinutes: Math.max(
      5,
      Math.min(30, selected.task.estimateMinutes, input.availableMinutes),
    ),
    reasons,
  };
}
