import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { loadServerEnv } from "../config/env";
import { LOCAL_OWNER_ID as owner } from "../security/local-owner";
import { createServiceContainer } from "./service-container";
import { approvedGoal, executionInput } from "./service-test-fixtures";
import { TaskCreateInputSchema } from "../repositories/revision-contracts";
import { ModelRequestSchema, type ModelRequest } from "../agent/model-contracts";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.$client.close()));
function setup() {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const services = createServiceContainer({ repositories, env: loadServerEnv({}) });
  const requests: string[] = [];
  const captured = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => ({
    async complete(request: ModelRequest) {
      requests.push(JSON.stringify(ModelRequestSchema.parse(request)));
      return { text: "根据保存的反馈分析。", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" };
    },
  }) });
  return { services, repositories, requests, async capture(goalId: string) {
    const start = requests.length;
    await captured.agent.processTurn(owner, { goalId, message: "我卡住了，请帮我分析。", explicitIntent: true, requestOperationId: randomUUID() });
    const serialized = requests[start];
    const request = ModelRequestSchema.parse(JSON.parse(serialized));
    const message = request.messages.find(m => m.role === "system" && m.content.startsWith("以下是服务器读取的上下文数据"))!;
    return { serialized, facts: JSON.parse(message.content.slice(message.content.indexOf("{") )) };
  } };
}

it("sends distinct same-category saved notes, task associations and deterministic trigger/availability facts in real requests", async () => {
  const { services, repositories, capture } = setup(); let w = await approvedGoal(services);
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), status: "blocked" }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const check = { goalId: w.goal.id, taskId: w.tasks[0].id, kind: "blocker" as const, blockerCategory: "missing_resource" as const, note: "没有练习用电脑", minutesSpent: null, availableWeeklyMinutes: null };
  await repositories.support.createCheckIn(owner, check);
  await repositories.support.createCheckIn(owner, { ...check, taskId: null, kind: "availability_change", blockerCategory: null, note: "本周出差", availableWeeklyMinutes: 30 });
  const first = await capture(w.goal.id);
  expect(first.facts.recentCheckIns).toEqual([
    expect.objectContaining({ taskId: w.tasks[0].id, taskTitle: w.tasks[0].title, blockerCategory: "missing_resource", note: "没有练习用电脑" }),
    expect.objectContaining({ taskId: null, taskTitle: null, availableWeeklyMinutes: 30, note: "本周出差" }),
  ]);
  expect(first.facts.planningFacts).toMatchObject({ latestAvailableWeeklyMinutes: 30, replanTriggers: expect.arrayContaining([
    { code: "availability_reduced", reason: "每周可用时间减少。" },
    { code: "unresolved_blocker", taskId: w.tasks[0].id, reason: "仍有资源或前置任务阻碍。" },
  ]) });
  await repositories.support.createCheckIn(owner, { ...check, note: "已有电脑但没有项目源码" });
  const second = await capture(w.goal.id);
  expect(second.serialized).toContain("已有电脑但没有项目源码");
  expect(first.serialized).not.toContain("已有电脑但没有项目源码");
  expect(second.facts.recentCheckIns.at(-1)).toMatchObject({ blockerCategory: "missing_resource", taskId: w.tasks[0].id, note: "已有电脑但没有项目源码" });
});

it.each(["retain", "reset", "remove"] as const)("projects %s task feedback without foreign goal/owner or raw persistence data", async mode => {
  const { services, repositories, capture } = setup(); let w = await approvedGoal(services);
  const taskId = w.tasks[2].id;
  const check = { taskId, goalId: w.goal.id, kind: "blocker" as const, blockerCategory: "task_too_large" as const, note: "当前叶任务反馈", minutesSpent: null, availableWeeklyMinutes: null };
  await repositories.support.createCheckIn(owner, check);
  await repositories.support.createCheckIn(owner, { ...check, taskId: null, note: "目标级反馈保留" });
  await repositories.support.createCheckIn(owner, { ...check, kind: "availability_change", blockerCategory: null,
    note: null, minutesSpent: null, availableWeeklyMinutes: 20 });
  const other = await approvedGoal(services);
  await repositories.support.createCheckIn(owner, { ...check, goalId: other.goal.id, taskId: other.tasks[0].id, note: "其他目标机密" });
  const foreignOwner = randomUUID();
  const foreign = await repositories.goals.create(foreignOwner, { title: "其他用户", category: "learning", desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null });
  await repositories.support.createCheckIn(foreignOwner, { ...check, goalId: foreign.id, taskId: null, note: "其他用户机密" });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  if (mode === "remove") await services.tasks.remove(owner, taskId, { goalId: w.goal.id, source: "ui_confirmation", confirmationPhrase: w.tasks[2].title, expectedTaskVersion: w.tasks[2].version, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  else {
    const draft = await services.plans.createManualDraft(owner, { goalId: w.goal.id, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, changeReason: "调整", tasks: w.tasks.map((t, i) => ({ ...TaskCreateInputSchema.strip().parse(t), ...(i === 2 ? mode === "reset" ? { doneCriteria: "新的验收标准" } : { title: "更易懂的标题" } : {}) })), operationId: randomUUID() });
    await services.approvals.approve(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() });
  }
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const { facts, serialized } = await capture(w.goal.id);
  expect(serialized).toContain("目标级反馈保留");
  for (const excluded of ["其他目标机密", "其他用户机密", "approvalGrants", "undoRecords", "parameterHash", "forwardPatch"]) expect(serialized).not.toContain(excluded);
  expect(facts.recentCheckIns).toContainEqual(expect.objectContaining({ taskId: null, taskTitle: null, note: "目标级反馈保留" }));
  if (mode === "retain") expect(facts.recentCheckIns).toContainEqual(expect.objectContaining({ taskId: w.tasks[2].id, taskTitle: "更易懂的标题", note: "当前叶任务反馈" }));
  else expect(serialized).not.toContain("当前叶任务反馈");
  // Availability is a goal-level budget fact even if its optional task association is no longer projected.
  expect(facts.planningFacts.latestAvailableWeeklyMinutes).toBe(20);
  expect(facts.planningFacts.estimatedRemainingCapacityMinutes).toBeTypeOf("number");
});

it("bounds recent feedback to ten records and 1000 Unicode characters while retaining older relevant availability", async () => {
  const { services, repositories, capture } = setup(); const w = await approvedGoal(services);
  const base = { goalId: w.goal.id, taskId: null, kind: "availability_change" as const, blockerCategory: null, note: "较早可用时间", minutesSpent: null, availableWeeklyMinutes: 15 };
  await repositories.support.createCheckIn(owner, base);
  for (let i = 0; i < 12; i++) await repositories.support.createCheckIn(owner, { ...base, kind: "blocker", blockerCategory: "missing_resource", availableWeeklyMinutes: null, note: `${i}:${"😀".repeat(1005)}` });
  const { facts, serialized } = await capture(w.goal.id);
  expect(facts.recentCheckIns).toHaveLength(10);
  expect(facts.recentCheckIns[0].note.startsWith("2:")).toBe(true);
  expect([...facts.recentCheckIns.at(-1).note]).toHaveLength(1000);
  expect(facts.recentCheckIns.at(-1).note.endsWith("😀")).toBe(true);
  expect(Object.keys(facts.recentCheckIns[0]).sort()).toEqual(["availableWeeklyMinutes", "blockerCategory", "createdAt", "kind", "minutesSpent", "note", "taskId", "taskTitle"].sort());
  expect(facts.recentCheckIns.every((checkIn: { taskTitle: string | null }) => checkIn.taskTitle === null)).toBe(true);
  expect(facts.recentCheckIns[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(facts.planningFacts.latestAvailableWeeklyMinutes).toBe(15);
  expect(serialized).not.toContain("较早可用时间");
});
