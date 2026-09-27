import type { Task } from "@/core/domain/contracts";

export type PlanDiff = {
  added: string[];
  removed: string[];
  moved: string[];
  changed: string[];
};

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function userEditableFieldsEqual(left: Task, right: Task): boolean {
  return (
    left.title === right.title &&
    left.action === right.action &&
    left.doneCriteria === right.doneCriteria &&
    left.evidenceType === right.evidenceType &&
    left.estimateMinutes === right.estimateMinutes &&
    left.dueAt === right.dueAt &&
    stringArraysEqual(left.dependencyIds, right.dependencyIds)
  );
}

export function diffPlans(oldTasks: readonly Task[], newTasks: readonly Task[]): PlanDiff {
  const oldById = new Map(oldTasks.map((task, index) => [task.id, { task, index }]));
  const newById = new Map(newTasks.map((task, index) => [task.id, { task, index }]));

  return {
    added: newTasks.filter((task) => !oldById.has(task.id)).map((task) => task.id),
    removed: oldTasks.filter((task) => !newById.has(task.id)).map((task) => task.id),
    moved: newTasks
      .filter((task, index) => oldById.has(task.id) && oldById.get(task.id)?.index !== index)
      .map((task) => task.id),
    changed: newTasks
      .filter((task) => {
        const previous = oldById.get(task.id)?.task;
        return previous !== undefined && !userEditableFieldsEqual(previous, task);
      })
      .map((task) => task.id),
  };
}
