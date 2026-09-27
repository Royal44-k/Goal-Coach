import type { Task } from "@/core/domain/contracts";

export type Progress = {
  completed: number;
  total: number;
  percent: number;
};

export function calculateProgress(tasks: readonly Task[]): Progress {
  const eligibleTasks = tasks.filter((task) => task.status !== "skipped");
  const completed = eligibleTasks.filter((task) => task.status === "done").length;
  const total = eligibleTasks.length;

  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

export function estimateBias(
  actualMinutes: number | null | undefined,
  estimateMinutes: number | null | undefined,
): number | null {
  if (!actualMinutes || !estimateMinutes) {
    return null;
  }

  return actualMinutes / estimateMinutes;
}
