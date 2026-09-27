import type { Task } from "@/core/domain/contracts";

export function findDependencyCycle(tasks: readonly Task[]): string[] | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  function visit(taskId: string): string[] | null {
    if (active.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      return [...path.slice(cycleStart), taskId];
    }
    if (visited.has(taskId)) {
      return null;
    }

    const task = tasksById.get(taskId);
    if (!task) {
      return null;
    }

    visited.add(taskId);
    active.add(taskId);
    path.push(taskId);

    for (const dependencyId of task.dependencyIds) {
      const cycle = visit(dependencyId);
      if (cycle) {
        return cycle;
      }
    }

    path.pop();
    active.delete(taskId);
    return null;
  }

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

export function getExecutableTasks(tasks: readonly Task[]): Task[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  return tasks.filter(
    (task) =>
      (task.status === "todo" || task.status === "doing") &&
      task.dependencyIds.every((dependencyId) => tasksById.get(dependencyId)?.status === "done"),
  );
}
