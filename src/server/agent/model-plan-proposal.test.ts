import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Goal, Task } from "@/core/domain/contracts";
import { assertModelPlanConstraints, modelPlanProposalArgsSchema } from "./model-plan-proposal";
import { modelToolDefinitions, toolRegistry } from "./tool-registry";

const task = () => ({ id: randomUUID(), title: "任务", action: "执行", doneCriteria: "有记录", evidenceType: "text" as const,
  estimateMinutes: 20, dueAt: null as string | null, dependencyIds: [] as string[] });
const proposal = () => ({ goalId: randomUUID(), payload: { base: { goalVersion: 2, planVersionId: null },
  milestones: ["完成"], changeReason: null, tasks: [task(), task(), task()] } });

it("accepts only the model's bounded plan proposal, not server metadata or persisted task fields", () => {
  const value = proposal();
  expect(modelPlanProposalArgsSchema.safeParse(value).success).toBe(true);
  for (const extra of ["diff", "executionResets", "changeSource", "schemaVersion"])
    expect(modelPlanProposalArgsSchema.safeParse({ ...value, payload: { ...value.payload, [extra]: {} } }).success).toBe(false);
  expect(modelPlanProposalArgsSchema.safeParse({ ...value, payload: { ...value.payload,
    tasks: [{ ...value.payload.tasks[0], status: "done" }, ...value.payload.tasks.slice(1)] } }).success).toBe(false);
  expect(modelPlanProposalArgsSchema.safeParse({ ...value, payload: { ...value.payload, tasks: value.payload.tasks.slice(0, 2) } }).success).toBe(false);
  expect(modelPlanProposalArgsSchema.safeParse({ ...value, payload: { ...value.payload,
    tasks: [{ ...value.payload.tasks[0], dependencyIds: [randomUUID()] }, ...value.payload.tasks.slice(1)] } }).success).toBe(false);
  expect(modelPlanProposalArgsSchema.safeParse({ ...value, payload: { ...value.payload,
    tasks: [value.payload.tasks[0], value.payload.tasks[0], value.payload.tasks[2]] } }).success).toBe(false);
  expect(toolRegistry.create_plan_draft.argsSchema.safeParse(value).success).toBe(false);
  for (const name of ["create_plan_draft", "propose_replan"] as const) {
    const advertised = modelToolDefinitions().find(definition => definition.name === name)!.inputSchema;
    const shape = advertised as { properties: { payload: { properties: Record<string, unknown> } } };
    expect(Object.keys(shape.properties.payload.properties).sort()).toEqual(["base", "changeReason", "milestones", "tasks"]);
  }
});

it("protects completed IDs against removal and transitive prerequisite resets without blocking historical due dates", () => {
  const [first, completed, last] = [task(), task(), task()];
  completed.dependencyIds = [first.id]; last.dependencyIds = [completed.id];
  completed.dueAt = "2026-11-01";
  const goal = { deadline: "2026-10-25" } as Goal;
  const source = [{ ...first, status: "todo" }, { ...completed, status: "done" },
    { ...last, status: "todo" }] as Task[];
  expect(() => assertModelPlanConstraints(goal, source, [first, completed, last], [], "2026-09-27T00:00:00+08:00")).not.toThrow();
  expect(() => assertModelPlanConstraints(goal, source, [{ ...first, action: "改写前置任务" }, completed, last], [], "2026-09-27T00:00:00+08:00"))
    .toThrowError(expect.objectContaining({ rule: "completed_task_reset" }));
  expect(() => assertModelPlanConstraints(goal, source, [first, { ...completed, id: randomUUID() }, last], [], "2026-09-27T00:00:00+08:00"))
    .toThrowError(expect.objectContaining({ rule: "completed_task_reset" }));
});

it.each(["todo", "doing", "blocked"] as const)("rejects a lower estimate for unchanged %s work despite metadata changes", status => {
  const old = { ...task(), action: "提取三份样本", doneCriteria: "三份均有记录", estimateMinutes: 90 };
  const source = [{ ...old, status }] as Task[];
  const next = { ...old, title: "新标题", dueAt: "2026-10-10", evidenceType: "check_answer" as const,
    dependencyIds: [randomUUID()], estimateMinutes: 60 };
  const goal = { deadline: null, weeklyMinutes: null } as Goal;
  expect(() => assertModelPlanConstraints(goal, source, [next], [], "2026-09-27T00:00:00+08:00"))
    .toThrowError(expect.objectContaining({ rule: "unchanged_work_estimate_reduced" }));
  expect(() => assertModelPlanConstraints(goal, source, [{ ...next, action: "用模板批量提取三份样本" }], [], "2026-09-27T00:00:00+08:00"))
    .toThrowError(expect.objectContaining({ rule: "unfinished_workload_reduced" }));
  expect(() => assertModelPlanConstraints(goal, source, [{ ...next, doneCriteria: "一份样本完成记录" }], [], "2026-09-27T00:00:00+08:00"))
    .toThrowError(expect.objectContaining({ rule: "unfinished_workload_reduced" }));
  expect(() => assertModelPlanConstraints(goal, source, [{ ...next, action: "用模板批量提取三份样本", estimateMinutes: 90 }], [], "2026-09-27T00:00:00+08:00"))
    .not.toThrow();
});

it("matches a removed unfinished task to a unique new ID only when its exact work key is unique on both sides", () => {
  const old = { ...task(), action: "整理三份样本", doneCriteria: "三份可查询", estimateMinutes: 90 };
  const source = [{ ...old, status: "todo" }] as Task[];
  const newId = { ...old, id: randomUUID(), estimateMinutes: 60 };
  const goal = { deadline: null, weeklyMinutes: null } as Goal;
  const now = "2026-09-27T00:00:00+08:00";
  expect(() => assertModelPlanConstraints(goal, source, [newId], [], now))
    .toThrowError(expect.objectContaining({ rule: "unchanged_work_estimate_reduced" }));
  expect(() => assertModelPlanConstraints(goal, source, [old, newId], [], now)).not.toThrow();
  expect(() => assertModelPlanConstraints(goal, source, [newId, { ...newId, id: randomUUID() }], [], now)).not.toThrow();
  expect(() => assertModelPlanConstraints(goal, [...source, { ...old, id: randomUUID(), status: "todo" } as Task],
    [newId, { ...task(), action: "新增独立核验", doneCriteria: "核验记录", estimateMinutes: 120 }], [], now)).not.toThrow();
  const duplicate = { ...old, id: randomUUID(), status: "todo" } as Task;
  expect(() => assertModelPlanConstraints(goal, [...source, duplicate], [{ ...old, estimateMinutes: 60 },
    { ...old, id: duplicate.id }], [], now))
    .toThrowError(expect.objectContaining({ rule: "unchanged_work_estimate_reduced" }));
});

it("does not re-estimate retained completed or skipped history, even with duplicate work text", () => {
  const old = { ...task(), action: "原工作", doneCriteria: "原标准", estimateMinutes: 90 };
  const goal = { deadline: null, weeklyMinutes: null } as Goal;
  const source = [{ ...old, status: "done" }, { ...old, id: randomUUID(), status: "skipped" }] as Task[];
  const proposed = source.map(value => ({ ...old, id: value.id, estimateMinutes: 60 }));
  expect(() => assertModelPlanConstraints(goal, source, proposed, [], "2026-09-27T00:00:00+08:00"))
    .not.toThrow();
});

it("rejects a lower unfinished total even when every action is rewritten or two tasks are merged", () => {
  const first = { ...task(), action: "整理样本", estimateMinutes: 90 };
  const second = { ...task(), action: "核验目录", estimateMinutes: 90 };
  const source = [{ ...first, status: "todo" }, { ...second, status: "blocked" }] as Task[];
  const goal = { deadline: null, weeklyMinutes: null } as Goal;
  const now = "2026-09-27T00:00:00+08:00";
  const rewritten = [{ ...first, action: "用新工具整理样本", estimateMinutes: 60 },
    { ...second, action: "快速核验目录", estimateMinutes: 60 }];
  expect(() => assertModelPlanConstraints(goal, source, rewritten, [], now))
    .toThrowError(expect.objectContaining({ rule: "unfinished_workload_reduced", workload: {
      currentUnfinishedMinutes: 180, proposedUnfinishedMinutes: 120 } }));
  const merged = [{ ...task(), action: "合并整理与核验流程", doneCriteria: "样本和目录均已核验", estimateMinutes: 100 }];
  expect(() => assertModelPlanConstraints(goal, source, merged, [], now))
    .toThrowError(expect.objectContaining({ rule: "unfinished_workload_reduced", workload: {
      currentUnfinishedMinutes: 180, proposedUnfinishedMinutes: 100 } }));
});

it("allows an equal-total split and excludes retained done/skipped work while counting reset skipped work", () => {
  const old = { ...task(), action: "交付目录", estimateMinutes: 120 };
  const source = [{ ...old, status: "todo" }] as Task[];
  const split = [{ ...task(), action: "整理目录", estimateMinutes: 50 },
    { ...task(), action: "核验目录", estimateMinutes: 70 }];
  const goal = { deadline: null, weeklyMinutes: null } as Goal;
  const now = "2026-09-27T00:00:00+08:00";
  expect(() => assertModelPlanConstraints(goal, source, split, [], now)).not.toThrow();
  const done = { ...task(), action: "已交付", estimateMinutes: 100 };
  const skipped = { ...task(), action: "已跳过", estimateMinutes: 90 };
  const history = [{ ...done, status: "done" }, { ...skipped, status: "skipped" }, ...source] as Task[];
  expect(() => assertModelPlanConstraints(goal, history, [done, skipped, ...split], [], now)).not.toThrow();
  const shortened = [{ ...old, action: "缩写目录", estimateMinutes: 110 }];
  expect(() => assertModelPlanConstraints(goal, history, [done, skipped, ...shortened], [], now))
    .toThrowError(expect.objectContaining({ rule: "unfinished_workload_reduced", workload: {
      currentUnfinishedMinutes: 120, proposedUnfinishedMinutes: 110 } }));
  expect(() => assertModelPlanConstraints(goal, history, [done, { ...skipped, action: "重新执行跳过项", estimateMinutes: 10 }, ...shortened], [], now))
    .not.toThrow();
});
