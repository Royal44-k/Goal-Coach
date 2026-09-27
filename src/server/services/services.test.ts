import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { loadServerEnv } from "../config/env";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { createServiceContainer } from "./service-container";
import { persistContractDraft } from "./draft-preparation";
import { GoalContractDraftPayloadSchema } from "../agent/tool-contracts";
import { contentHash } from "../security/canonical-json";
import { LOCAL_TYPESCRIPT_INPUT, LOCAL_TYPESCRIPT_DONE } from "../agent/local-mock-model-client";
import { TaskCreateInputSchema, PlanRevisionEnvelopeSchema } from "../repositories/revision-contracts";
import { makePlanPayload, persistPlanDraft } from "./draft-preparation";
import { ApprovalService } from "../security/approval-service";
import { approvedGoal, executionInput } from "./service-test-fixtures";
import { MockModelClient } from "../agent/mock-model-client";
import {
  DeletedCountsSchema as PublicDeletedCountsSchema,
  ExportBundleSchema as PublicExportBundleSchema,
  GOAL_REVIEW_REQUEST_MESSAGE,
  PreferencesUpdateSchema as PublicPreferencesUpdateSchema,
  SettingsUpdateSchema as PublicSettingsUpdateSchema,
  UserPreferenceCreateInputSchema as PublicPreferenceCreateInputSchema,
} from "@/lib/public-api-schemas";
import {
  ExportBundleSchema as ServiceExportBundleSchema,
  PreferencesUpdateSchema as ServicePreferencesUpdateSchema,
  SettingsUpdateSchema as ServiceSettingsUpdateSchema,
} from "./service-contracts";
import { UserPreferenceCreateInputSchema as RepositoryPreferenceCreateInputSchema } from "../repositories/repository-inputs";
import { DeletedCountsSchema as ToolDeletedCountsSchema } from "../agent/tool-contracts";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.$client.close()); vi.useRealTimers(); });
function setup(now = "2026-09-04T16:01:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const services = createServiceContainer({ repositories, env: loadServerEnv({}), now: () => new Date(now) });
  return { db, repositories, services };
}
const owner = LOCAL_OWNER_ID;
const contract = { title: "学习 TypeScript", category: "learning" as const, desiredOutcome: "做一个待办网页", definitionOfDone: "新增、完成、删除并刷新保留", deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
// Complete user workflows and displayed execution snapshots are test-only helpers.
it("preserves server contract exports as the canonical client-safe validator instances", () => {
  expect(ServiceSettingsUpdateSchema).toBe(PublicSettingsUpdateSchema);
  expect(ServicePreferencesUpdateSchema).toBe(PublicPreferencesUpdateSchema);
  expect(ServiceExportBundleSchema).toBe(PublicExportBundleSchema);
  expect(RepositoryPreferenceCreateInputSchema).toBe(PublicPreferenceCreateInputSchema);
  expect(ToolDeletedCountsSchema).toBe(PublicDeletedCountsSchema);
});

it("runs no-key fixture goals independently and approves stored milestones with agent attribution", async () => {
  const { services } = setup();
  const first = await approvedGoal(services), second = await approvedGoal(services);
  expect(first.goal.id).not.toBe(second.goal.id);
  expect(first.tasks).toHaveLength(3);
  expect(first.currentPlan).toMatchObject({ changeSource: "agent", milestones: ["掌握 TypeScript 基础类型", "完成待办网页交互", "验证刷新后的记录保留"] });
  expect(first.tasks[1].dependencyIds).toEqual([first.tasks[0].id]);
  expect(second.tasks.map(t => t.id)).not.toEqual(first.tasks.map(t => t.id));
  expect((await services.data.export(owner)).planVersions).toHaveLength(2);
});
it("completion is atomic, evidence stays after undo and historical replay does not apply again", async () => {
  const { services, db } = setup();
  let w = await approvedGoal(services);
  const task = w.tasks[0];
  const input = { ...executionInput(w), status: "done", actualMinutes: 25, evidence: { type: "text", text: "类型检查通过" } };
  const result = await services.tasks.update(owner, task.id, input, "ui_explicit");
  expect(await services.tasks.update(owner, task.id, input, "ui_explicit")).toEqual(result);
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w).toMatchObject({ canUndo: true, progress: { completed: 1 } });
  expect(w.evidence).toHaveLength(1);
  expect(db.$client.prepare("SELECT count(*) AS n FROM undo_records").get()).toEqual({ n: 1 });
  await expect(services.tasks.update(owner, task.id, { ...input, evidence: { type: "text", text: "另一个结果" } }, "ui_explicit")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  expect(await services.tasks.update(owner, task.id, input, "ui_explicit")).toEqual(result);
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks[0].status).toBe("todo"); expect(w.evidence).toHaveLength(1); expect(w.canUndo).toBe(false);
  await expect(services.tasks.update(owner, task.id, { ...executionInput(w), status: "done", evidence: { type: "file_metadata", fileName: "x", fileSize: 1, mimeType: "text/plain" } }, "ui_explicit")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});
it("persists tiny positive bias through completion, evidence, undo, replay and later reconciliation", async () => {
  const { services, db } = setup();
  let w = await approvedGoal(services);
  const draft = await services.plans.createManualDraft(owner, {
    goalId: w.goal.id, expectedGoalVersion: w.goal.version,
    expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version },
    changeReason: "记录完整练习预算", operationId: randomUUID(),
    tasks: w.tasks.map(t => ({ ...TaskCreateInputSchema.strip().parse(t), estimateMinutes: 300 })),
  });
  await services.approvals.approve(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const input = { ...executionInput(w), status: "done", actualMinutes: 1, evidence: { type: "text", text: "已验证此前完成的练习" } };
  const completed = await services.tasks.update(owner, w.tasks[0].id, input, "ui_explicit");
  expect(await services.tasks.update(owner, completed.id, input, "ui_explicit")).toEqual(completed);
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks[0]).toMatchObject({ status: "done", actualMinutes: 1 });
  expect(w.preference?.estimateBias).toBe(0.01);
  expect(w.evidence).toHaveLength(1);
  expect(w.canUndo).toBe(true);
  expect(db.$client.prepare("SELECT count(*) AS n FROM undo_records").get()).toEqual({ n: 1 });
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  expect(await services.tasks.update(owner, completed.id, input, "ui_explicit")).toEqual(completed);
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks[0]).toMatchObject({ status: "todo", actualMinutes: null });
  expect(w.preference?.estimateBias).toBe(1);
  expect(w.evidence).toHaveLength(1);
  expect(w.canUndo).toBe(false);
  await services.tasks.update(owner, w.tasks[0].id, { ...input, ...executionInput(w) }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), actualMinutes: 2 }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  await services.tasks.recordCheckIn(owner, w.goal.id, { taskId: null, kind: "availability_change", blockerCategory: null, note: null, minutesSpent: null, availableWeeklyMinutes: 120, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks[0]).toMatchObject({ status: "done", actualMinutes: 2 });
  expect(w.preference?.estimateBias).toBe(0.01);
  expect(w.evidence).toHaveLength(2);
  expect(w.checkIns).toHaveLength(1);
});
it.each([undefined, "synthetic-presence-only-key"])("projects key presence without persisting credentials: %s", async apiKey => {
  const { repositories } = setup();
  const services = createServiceContainer({ repositories, env: loadServerEnv({ DASHSCOPE_API_KEY: apiKey }) });
  const first = await services.settings.get(owner);
  expect(first).toMatchObject({ provider: "mock", apiKeyConfigured: apiKey !== undefined });
  const updated = await services.settings.update(owner, { expectedVersion: first.version, provider: "qwen" });
  expect(updated).toMatchObject({ provider: "qwen", apiKeyConfigured: apiKey !== undefined });
  const persisted = await repositories.support.getSettingsByOwner(owner);
  expect(persisted).not.toHaveProperty("apiKeyConfigured");
  for (const field of ["apiKey", "baseURL", "DASHSCOPE_API_KEY"]) {
    expect(updated).not.toHaveProperty(field);
    expect(persisted).not.toHaveProperty(field);
  }
  if (apiKey) expect(JSON.stringify(updated)).not.toContain(apiKey);
  for (const extra of [{ apiKeyConfigured: true }, { apiKey: "injected" }, { baseURL: "https://invalid.example" }, { DASHSCOPE_API_KEY: "injected" }]) {
    await expect(services.settings.update(owner, { expectedVersion: updated.version, ...extra })).rejects.toBeDefined();
  }
  expect(await repositories.support.getSettingsByOwner(owner)).toEqual(persisted);
});
it("bounds explicit preference edits while preserving canonical edits and old stored values", async () => {
  const { services, repositories } = setup();
  let pref = await services.settings.getPreferences(owner);
  pref = await services.settings.updatePreferences(owner, {
    expectedVersion: pref.version, preferredTimeWindow: ` ${"晚".repeat(120)} `,
    effectiveStrategies: Array.from({ length: 10 }, () => ` ${"步".repeat(240)} `),
    estimateBias: 1.25, taskGranularity: "small", commonBlockers: ["insufficient_time"],
  });
  expect(pref).toMatchObject({ preferredTimeWindow: "晚".repeat(120), effectiveStrategies: Array(10).fill("步".repeat(240)), estimateBias: 1.25, taskGranularity: "small", commonBlockers: ["insufficient_time"] });
  const invalid = [
    { preferredTimeWindow: "晚".repeat(121) }, { preferredTimeWindow: "  " }, { preferredTimeWindow: 1 },
    { effectiveStrategies: Array(11).fill("策略") }, { effectiveStrategies: ["步".repeat(241)] },
    { effectiveStrategies: [" "] }, { effectiveStrategies: "策略" }, { effectiveStrategies: [1] },
  ];
  for (const patch of invalid) {
    expect(() => services.settings.updatePreferences(owner, { expectedVersion: pref.version, ...patch })).toThrow();
    expect(await services.settings.getPreferences(owner)).toEqual(pref);
  }
  pref = await services.settings.updatePreferences(owner, { expectedVersion: pref.version, preferredTimeWindow: null, effectiveStrategies: [] });
  expect(pref).toMatchObject({ preferredTimeWindow: null, effectiveStrategies: [] });
  const legacy = await repositories.support.updateUserPreference(owner, pref.id, pref.version, { preferredTimeWindow: "旧".repeat(121), effectiveStrategies: ["旧".repeat(241)] });
  expect(await services.settings.getPreferences(owner)).toEqual(legacy);
  expect(await services.settings.clearPreferences(owner)).toMatchObject({ preferredTimeWindow: null, effectiveStrategies: [] });
});
it("offline paused manual approval preserves history, evidence, pause, and roadmap", async () => {
  const { services } = setup();
  let w = await approvedGoal(services);
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), status: "done", evidence: { type: "text", text: "完成" } }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  await services.goals.changeStatus(owner, w.goal.id, { status: "paused", expectedVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const input = { goalId: w.goal.id, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, changeReason: "调整标题", tasks: w.tasks.map((t, i) => ({ ...TaskCreateInputSchema.strip().parse(t), title: i === 1 ? "新的标题" : t.title })), operationId: randomUUID() };
  const draft = await services.plans.createManualDraft(owner, input);
  expect(await services.plans.createManualDraft(owner, input)).toEqual(draft);
  await services.approvals.approve(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() });
  const next = await services.goals.getWorkspace(owner, w.goal.id);
  expect(next.goal).toMatchObject({ status: "paused", agentState: "paused" });
  expect(next.currentPlan!.milestones).toEqual(w.currentPlan!.milestones);
  expect(next.currentPlan!.changeSource).toBe("user");
  expect(next.tasks[0].status).toBe("done"); expect(next.evidence).toHaveLength(1);
  expect(next.tasks[0].id).not.toBe(w.tasks[0].id); expect(next.planHistory).toHaveLength(2);
});
it("rejection preserves plan and allows a fresh explicit repeated proposal", async () => {
  const { services } = setup();
  let w = await approvedGoal(services);
  await services.tasks.recordCheckIn(owner, w.goal.id, { taskId: w.tasks[0].id, kind: "blocker", blockerCategory: "task_too_large", note: " ", minutesSpent: null, availableWeeklyMinutes: null, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  const advice = await services.agent.processTurn(owner, { goalId: w.goal.id, message: "我卡住了，请帮我分析。", requestOperationId: randomUUID() });
  expect(advice.advice?.blockerCategory).toBe("task_too_large");
  for (const message of ["请根据最新反馈调整计划。", "请重新提出调整方案。"]) {
    const beforeMinutes = w.tasks.reduce((total, task) => total + task.estimateMinutes, 0);
    const result = await services.agent.processTurn(owner, { goalId: w.goal.id, message, requestOperationId: randomUUID() });
    const review = await services.goals.getWorkspace(owner, w.goal.id);
    const draft = review.pendingDrafts.find(d => d.id === result.draftId)!;
    expect(draft?.kind).toBe("replan");
    if (draft.kind !== "replan") throw new Error("Expected a replan draft");
    const proposed = draft.payload.tasks;
    expect(proposed).toHaveLength(w.tasks.length + 1);
    expect(proposed.reduce((total, task) => total + task.estimateMinutes, 0)).toBe(beforeMinutes);
    const starter = proposed.find(task => !w.tasks.some(current => current.id === task.id));
    expect(starter).toMatchObject({ estimateMinutes: 20, evidenceType: "text", dependencyIds: [] });
    expect(starter?.action).toContain("Todo 接口");
    expect(starter?.doneCriteria).toContain("类型检查");
    const original = proposed.find(task => task.id === w.tasks[0].id);
    expect(original?.estimateMinutes).toBe(w.tasks[0].estimateMinutes - 20);
    expect(original?.dependencyIds).toEqual([starter?.id]);
    expect(original?.action).toContain("起步任务");
    expect(original?.doneCriteria).toBe(w.tasks[0].doneCriteria);
    const input = { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: review.goal.version, operationId: randomUUID() };
    const rejected = await services.plans.rejectReplan(owner, input);
    expect(await services.plans.rejectReplan(owner, input)).toEqual(rejected);
    w = await services.goals.getWorkspace(owner, w.goal.id);
    expect(w.goal.agentState).toBe("active"); expect(w.pendingDrafts).toHaveLength(0); expect(w.planHistory).toHaveLength(1);
  }
});
it("mock replan leaves completed work intact when splitting the next task", async () => {
  const { services } = setup();
  let w = await approvedGoal(services);
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), status: "done", evidence: { type: "text", text: "类型检查通过" } }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const completed = TaskCreateInputSchema.strip().parse(w.tasks[0]);
  const unfinishedMinutes = w.tasks.slice(1).reduce((total, task) => total + task.estimateMinutes, 0);
  const result = await services.agent.processTurn(owner, { goalId: w.goal.id, message: "请根据最新反馈调整计划。", requestOperationId: randomUUID() });
  const review = await services.goals.getWorkspace(owner, w.goal.id);
  const draft = review.pendingDrafts.find(candidate => candidate.id === result.draftId);
  expect(draft?.kind).toBe("replan");
  if (draft?.kind !== "replan") throw new Error("Expected a replan draft");
  expect(draft.payload.tasks.find(task => task.id === completed.id)).toEqual(completed);
  expect(draft.payload.tasks.filter(task => task.id !== completed.id).reduce((total, task) => total + task.estimateMinutes, 0)).toBe(unfinishedMinutes);
  const starter = draft.payload.tasks.find(task => !w.tasks.some(existing => existing.id === task.id));
  expect(starter?.title).toBe("实现并验证新增待办");
  expect(draft.payload.tasks.find(task => task.id === w.tasks[1].id)?.dependencyIds).toEqual([starter?.id]);
});
it("mock replan truthfully declines a split when the plan already has eight tasks", async () => {
  const { services } = setup();
  let w = await approvedGoal(services);
  const extraTasks = Array.from({ length: 5 }, (_, index) => ({
    ...TaskCreateInputSchema.strip().parse(w.tasks[0]), id: randomUUID(), title: `额外验证步骤 ${index + 1}`,
    action: `独立核对待办网页的第 ${index + 1} 条样例。`, doneCriteria: `记录第 ${index + 1} 条样例的核对结果。`,
    estimateMinutes: 20, dependencyIds: [],
  }));
  const manual = await services.plans.createManualDraft(owner, {
    goalId: w.goal.id, expectedGoalVersion: w.goal.version,
    expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version },
    tasks: [...w.tasks.map(task => TaskCreateInputSchema.strip().parse(task)), ...extraTasks],
    changeReason: "验证八任务时的预设流程边界", operationId: randomUUID(),
  });
  await services.approvals.approve(owner, { goalId: w.goal.id, draftId: manual.id, expectedDraftVersion: manual.version, toolName: "save_approved_plan", operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks).toHaveLength(8);
  const result = await services.agent.processTurn(owner, { goalId: w.goal.id, message: "请根据最新反馈调整计划。", requestOperationId: randomUUID() });
  expect(result.draftId).toBeUndefined();
  expect(result.message).toContain("八项任务");
  expect(result.message).toContain("未保存调整草案");
  const review = await services.goals.getWorkspace(owner, w.goal.id);
  expect(review.pendingDrafts).toHaveLength(0);
  expect(review.tasks).toEqual(w.tasks);
});
it("mock replan declines inherited object-property task titles without mutating the plan", async () => {
  const { services } = setup();
  let w = await approvedGoal(services);
  const renamed = w.tasks.map((task, index) => ({
    ...TaskCreateInputSchema.strip().parse(task), title: ["constructor", "toString", "__proto__"][index],
  }));
  const manual = await services.plans.createManualDraft(owner, {
    goalId: w.goal.id, expectedGoalVersion: w.goal.version,
    expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version },
    tasks: renamed, changeReason: "验证预设流程对不支持任务名的边界", operationId: randomUUID(),
  });
  await services.approvals.approve(owner, { goalId: w.goal.id, draftId: manual.id, expectedDraftVersion: manual.version, toolName: "save_approved_plan", operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks.map(task => task.title)).toEqual(["constructor", "toString", "__proto__"]);
  const result = await services.agent.processTurn(owner, { goalId: w.goal.id, message: "请根据最新反馈调整计划。", requestOperationId: randomUUID() });
  expect(result.draftId).toBeUndefined();
  expect(result.message).toContain("没有可安全拆分");
  const review = await services.goals.getWorkspace(owner, w.goal.id);
  expect(review.pendingDrafts).toHaveLength(0);
  expect(review.tasks).toEqual(w.tasks);
});
it("deletes a used last dependency task through history and replays goal deletion without the goal", async () => {
  const { services, repositories } = setup();
  let w = await approvedGoal(services);
  const input = { ...executionInput(w, 2), status: "done", evidence: { type: "text", text: "保存后刷新记录存在" } };
  await services.tasks.update(owner, w.tasks[2].id, input, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const removed = w.tasks[2];
  await services.tasks.remove(owner, removed.id, { goalId: w.goal.id, source: "ui_confirmation", confirmationPhrase: removed.title, expectedTaskVersion: removed.version, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).tasks).toHaveLength(2);
  expect(await repositories.tasks.get(owner, removed.id)).toEqual(removed);
  expect(await repositories.support.listEvidenceByTask(owner, removed.id)).toHaveLength(1);
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const confirmation = { source: "ui_confirmation", confirmationPhrase: w.goal.title, expectedGoalVersion: w.goal.version, operationId: randomUUID() };
  await services.goals.remove(owner, w.goal.id, confirmation);
  await services.goals.remove(owner, w.goal.id, confirmation);
  expect(await services.goals.list(owner)).toEqual([]);
  expect((await repositories.support.listModelUsageReceipts(owner, "2026-09-05")).length).toBeGreaterThan(0);
});
it("clear retains exactly its content-free operation and fresh default setting and rejects stale generations", async () => {
  const { services, db } = setup();
  await approvedGoal(services);
  const before = await services.settings.get(owner);
  const input = { confirmationPhrase: "清除我的全部本地数据", expectedSettingId: before.id, operationId: randomUUID() };
  const cleared = await services.data.clear(owner, input);
  expect(await services.data.clear(owner, input)).toEqual(cleared);
  const after = await services.settings.get(owner);
  expect(after.id).not.toBe(before.id); expect(after.privacyAcceptedAt).toBeNull();
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) if (name !== "__drizzle_migrations") {
    const count = db.$client.prepare(`SELECT count(*) AS n FROM ${name}`).get();
    expect(count).toEqual({ n: name === "operations" || name === "app_settings" ? 1 : 0 });
  }
  const row = db.$client.prepare("SELECT * FROM operations").get();
  expect(JSON.stringify(row)).not.toContain("TypeScript");
  await services.data.clear(owner, { ...input, expectedSettingId: after.id, operationId: randomUUID() });
  await expect(services.data.clear(owner, input)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
it("provider edits apply next turn and replay does not instantiate an unused factory", async () => {
  const { services: unused, repositories } = setup(); void unused;
  let factories = 0;
  const services = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => {
    factories++;
    return new MockModelClient([{ text: "预设回复。", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" }]);
  } });
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "私人目标" });
  const input = { goalId: goal.id, message: "继续", requestOperationId: randomUUID() };
  const result = await services.agent.processTurn(owner, input);
  const setting = await services.settings.get(owner);
  const changed = await services.settings.update(owner, { expectedVersion: setting.version, provider: "qwen" });
  await services.settings.update(owner, { expectedVersion: changed.version, privacyAccepted: true, privacyProvider: "qwen", privacyPolicyVersion: "2026-09-24" });
  expect(await services.agent.processTurn(owner, input)).toEqual(result); expect(factories).toBe(1);
  await expect(services.agent.processTurn(owner, { ...input, requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "MODEL_CONFIG_MISSING" });
});
it("decorates the lazily selected model once per turn and does not decorate a replay", async () => {
  const { repositories } = setup();
  let decorated = 0;
  let calls = 0;
  const metadata: Array<{ provider: string; seed: { ownerId: string; goalId: string; userMessage: string } }> = [];
  const services = createServiceContainer({
    repositories,
    env: loadServerEnv({}),
    mockClientFactory: seed => ({ async complete() {
      calls++;
      return calls === 1
        ? { text: "", toolCalls: [{ id: randomUUID(), name: "get_goal", argumentsJson: JSON.stringify({ goalId: seed.goalId }) }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }
        : { text: "已读取目标。", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
    } }),
    modelClientDecorator: (client, details) => {
      decorated++;
      metadata.push(details);
      return { complete: request => client.complete(request) };
    },
  });
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "目标" });
  const input = { goalId: goal.id, message: "继续", requestOperationId: randomUUID() };
  const result = await services.agent.processTurn(owner, input);

  expect(result.usage.modelCalls).toBe(2);
  expect(decorated).toBe(1);
  expect(metadata).toEqual([{ provider: "mock", seed: { ownerId: owner, goalId: goal.id, userMessage: "继续" } }]);
  expect(await services.agent.processTurn(owner, input)).toEqual(result);
  expect(decorated).toBe(1);
});
it("qwen environment defaults remain usable for settings and offline work without credentials", async () => {
  const { repositories } = setup();
  const services = createServiceContainer({ repositories, env: loadServerEnv({ MODEL_PROVIDER: "qwen" }) });
  expect((await services.settings.get(owner)).provider).toBe("qwen");
});
it("rejects stale displayed goal, plan, task and spoofed source without writing execution", async () => {
  const { services } = setup(); const w = await approvedGoal(services), original = executionInput(w);
  for (const patch of [{ expectedGoalVersion: w.goal.version + 1 }, { expectedVersion: 99 }, { expectedPlanVersion: { id: randomUUID(), version: 1 } }])
    await expect(services.tasks.update(owner, w.tasks[0].id, { ...original, ...patch, status: "doing", operationId: randomUUID() }, "ui_explicit")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(services.tasks.update(owner, w.tasks[0].id, { ...original, status: "doing" }, "model")).rejects.toMatchObject({ code: "ORIGIN_REJECTED" });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).tasks).toEqual(w.tasks);
});
it("late evidence completion failure rolls back evidence, task, undo, signals and operation", async () => {
  const { services, db } = setup(); const w = await approvedGoal(services);
  db.$client.exec("CREATE TRIGGER reject_execution_audit BEFORE INSERT ON audit_events WHEN NEW.type = 'tool_executed' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  const input = { ...executionInput(w), status: "done", evidence: { type: "text", text: "完成" } };
  await expect(services.tasks.update(owner, w.tasks[0].id, input, "ui_explicit")).rejects.toBeDefined();
  expect(await services.goals.getWorkspace(owner, w.goal.id)).toEqual(w);
  expect(db.$client.prepare("SELECT count(*) AS n FROM undo_records").get()).toEqual({ n: 0 });
  expect(db.$client.prepare("SELECT count(*) AS n FROM operations WHERE operation_id = ?").get(input.operationId)).toEqual({ n: 0 });
});
it("full completion enters reviewing, undo returns active, explicit completion requires saved reflection", async () => {
  const { services } = setup(); let w = await approvedGoal(services);
  await expect(services.goals.changeStatus(owner, w.goal.id, { status: "completed", expectedVersion: w.goal.version, operationId: randomUUID() })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  for (let index = 0; index < 3; index++) {
    await services.tasks.update(owner, w.tasks[index].id, { ...executionInput(w, index), status: "done", evidence: { type: "text", text: `第${index + 1}项结果` } }, "ui_explicit");
    w = await services.goals.getWorkspace(owner, w.goal.id);
  }
  expect(w.goal).toMatchObject({ status: "active", agentState: "reviewing" });
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.goal.agentState).toBe("active"); expect(w.evidence).toHaveLength(3);
  await services.tasks.update(owner, w.tasks[2].id, { ...executionInput(w, 2), status: "done", evidence: { type: "text", text: "重新验证" } }, "ui_explicit");
  await services.agent.processTurn(owner, { goalId: w.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const completed = await services.goals.changeStatus(owner, w.goal.id, { status: "completed", expectedVersion: w.goal.version, operationId: randomUUID() });
  expect(completed.status).toBe("completed"); expect((await services.goals.getWorkspace(owner, w.goal.id)).canUndo).toBe(false);
});
it("all-skipped execution stays active and derived preferences preserve user time window and strategies", async () => {
  const { services } = setup(); let w = await approvedGoal(services);
  const pref = await services.settings.getPreferences(owner);
  await services.settings.updatePreferences(owner, { expectedVersion: pref.version, preferredTimeWindow: "晚上", effectiveStrategies: ["先打开文件"] });
  for (let index = 0; index < 3; index++) {
    await services.tasks.update(owner, w.tasks[index].id, { ...executionInput(w, index), status: "skipped" }, "ui_explicit");
    w = await services.goals.getWorkspace(owner, w.goal.id);
  }
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), status: "skipped" }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.progress).toEqual({ completed: 0, total: 0, percent: 0 }); expect(w.goal.agentState).toBe("active");
  expect(w.replanTriggers).toContainEqual({ code: "repeated_skip", taskId: w.tasks[0].id, reason: "同一任务已多次跳过。" });
  expect(w.preference).toMatchObject({ preferredTimeWindow: "晚上", effectiveStrategies: ["先打开文件"] });
});
it("milestone-only replan is sealed and approved without task reset or source forgery", async () => {
  const { services, repositories } = setup(); let w = await approvedGoal(services);
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), status: "done", evidence: { type: "text", text: "学习结果" } }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const payload = makePlanPayload(w.goal, w.tasks, w.tasks.map(t => TaskCreateInputSchema.strip().parse(t)), ["新增检查点", ...w.currentPlan!.milestones], "完善路线", "user");
  const proposal = { base: payload.base, milestones: payload.milestones, changeReason: payload.changeReason, tasks: payload.tasks };
  const queued = new MockModelClient([{ text: "", toolCalls: [{ id: randomUUID(), name: "propose_replan", argumentsJson: JSON.stringify({ goalId: w.goal.id, payload: proposal }) }], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "tool_calls" }, { text: "请查看草案。", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" }]);
  const injected = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => queued });
  const proposed = await injected.agent.processTurn(owner, { goalId: w.goal.id, message: "修改路线", requestOperationId: randomUUID() });
  const review = await services.goals.getWorkspace(owner, w.goal.id), draft = review.pendingDrafts.find(d => d.id === proposed.draftId)!;
  expect(draft.payload).toMatchObject({ changeSource: "agent", executionResets: [], diff: { added: [], removed: [], moved: [], changed: [] } });
  await services.approvals.approve(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() });
  const after = await services.goals.getWorkspace(owner, w.goal.id);
  expect(after.tasks[0].status).toBe("done"); expect(after.evidence).toHaveLength(1); expect(after.currentPlan!.changeSource).toBe("agent");
  expect(after.currentPlan!.milestones[0]).toBe("新增检查点");
  expect(PlanRevisionEnvelopeSchema.parse(after.planHistory[0].diff).revision.payload.milestones).toEqual(w.currentPlan!.milestones);
  await expect(repositories.withTransaction(tx => persistPlanDraft(tx, owner, after.goal.id, makePlanPayload(after.goal, after.tasks, after.tasks.map(t => TaskCreateInputSchema.strip().parse(t)), after.currentPlan!.milestones, "无变化", "agent"), "agent"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  const forged = makePlanPayload(after.goal, after.tasks, after.tasks.map((task, index) => ({ ...TaskCreateInputSchema.strip().parse(task),
    ...(index === 0 ? { title: "改名" } : {}) })), after.currentPlan!.milestones, "再次调整", "user");
  await expect(repositories.withTransaction(tx => persistPlanDraft(tx, owner, after.goal.id,
    { ...forged, diff: { ...forged.diff, changed: [] } }, "user"))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
it("pending replan rejects hash tampering and stale progress, obsolete dismissal keeps newer state", async () => {
  const { services, repositories, db } = setup(); const w = await approvedGoal(services);
  const draft = await services.plans.createManualDraft(owner, { goalId: w.goal.id, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, changeReason: "调整", tasks: w.tasks.map((t, i) => ({ ...TaskCreateInputSchema.strip().parse(t), title: i === 0 ? "新标题" : t.title })), operationId: randomUUID() });
  db.$client.prepare("UPDATE draft_artifacts SET content_hash = ? WHERE id = ?").run("0".repeat(64), draft.id);
  const approval = { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() };
  await expect(services.approvals.approve(owner, approval)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  db.$client.prepare("UPDATE draft_artifacts SET content_hash = ? WHERE id = ?").run(draft.contentHash, draft.id);
  const current = (await repositories.goals.get(owner, w.goal.id))!;
  const progressed = await repositories.goals.update(owner, w.goal.id, current.version, {});
  await expect(services.approvals.approve(owner, approval)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const newer = await repositories.goals.update(owner, w.goal.id, progressed.version, { agentState: "active" });
  await services.plans.rejectReplan(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: newer.version, operationId: randomUUID() });
  expect(await repositories.goals.get(owner, w.goal.id)).toEqual(newer);
  expect((await services.goals.getWorkspace(owner, w.goal.id)).tasks).toEqual(w.tasks);
});
it("old contract grants cannot authorize replacement and competing stale edits roll back", async () => {
  const { services, repositories } = setup();
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT });
  await services.agent.processTurn(owner, { goalId: goal.id, message: LOCAL_TYPESCRIPT_DONE, requestOperationId: randomUUID() });
  const w = await services.goals.getWorkspace(owner, goal.id), draft = w.pendingDrafts[0];
  if (draft.kind !== "goal_contract") throw new Error("fixture");
  const approvals = new ApprovalService(repositories.support);
  const grant = await approvals.issue({ ownerId: owner, subjectId: draft.id, toolName: "save_approved_contract", payload: draft.payload });
  const input = { draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: w.goal.version, contract: { ...draft.payload.contract, weeklyMinutes: 90 }, operationId: randomUUID() };
  const replacement = await services.goals.replaceContractDraft(owner, goal.id, input);
  await expect(approvals.consume({ ownerId: owner, grantId: grant.id, subjectId: replacement.id, toolName: "save_approved_contract", payload: replacement.payload })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  await expect(services.goals.replaceContractDraft(owner, goal.id, { ...input, operationId: randomUUID() })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
it("paused deletion can reach an empty task window while preserving the sealed roadmap", async () => {
  const { services } = setup(); let w = await approvedGoal(services);
  await services.goals.changeStatus(owner, w.goal.id, { status: "paused", expectedVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id); const milestones = w.currentPlan!.milestones;
  await expect(services.tasks.remove(owner, w.tasks[0].id, { goalId: w.goal.id, source: "ui_confirmation", confirmationPhrase: w.tasks[0].title, expectedGoalVersion: w.goal.version, expectedTaskVersion: w.tasks[0].version, operationId: randomUUID() })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  while (w.tasks.length) {
    const task = w.tasks.at(-1)!;
    await services.tasks.remove(owner, task.id, { goalId: w.goal.id, source: "ui_confirmation", confirmationPhrase: task.title, expectedGoalVersion: w.goal.version, expectedTaskVersion: task.version, operationId: randomUUID() });
    w = await services.goals.getWorkspace(owner, w.goal.id);
    expect(w.goal).toMatchObject({ status: "paused", agentState: "paused" }); expect(w.currentPlan!.milestones).toEqual(milestones);
  }
  expect(w.progress.total).toBe(0); expect(w.nextAction).toBeNull(); expect(w.planHistory).toHaveLength(4);
});
it("clear cancels an in-flight pre-clear reply without resurrecting receipts, runs or content", async () => {
  const { repositories, db } = setup();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const services = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => ({ async complete() { started(); await wait; return { text: "迟到内容", toolCalls: [], usage: { inputTokens: 7, outputTokens: 3 }, finishReason: "stop" }; } }) });
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "内容" });
  const pending = services.agent.processTurn(owner, { goalId: goal.id, message: "继续", requestOperationId: randomUUID() });
  const observed = pending.catch(error => error);
  await entered; const setting = await services.settings.get(owner);
  await services.data.clear(owner, { confirmationPhrase: "清除我的全部本地数据", expectedSettingId: setting.id, operationId: randomUUID() });
  release(); expect(await observed).toMatchObject({ code: "VERSION_CONFLICT" });
  expect(db.$client.prepare("SELECT count(*) AS n FROM operations").get()).toEqual({ n: 1 });
  expect(db.$client.prepare("SELECT count(*) AS n FROM agent_runs").get()).toEqual({ n: 0 });
  expect((await services.data.export(owner)).goals).toEqual([]);
});
it("workspace labels the suggested thirty-minute window without claiming personal availability", async () => {
  const { services, repositories } = setup(); const w = await approvedGoal(services);
  const draft = await services.plans.createManualDraft(owner, { goalId: w.goal.id, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, changeReason: "缩短起步", tasks: w.tasks.map(t => ({ ...TaskCreateInputSchema.strip().parse(t), estimateMinutes: 15 })), operationId: randomUUID() });
  await services.approvals.approve(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() });
  const next = await services.goals.getWorkspace(owner, w.goal.id);
  expect(next.nextAction?.reasons[0]).toBe("按30分钟起步窗口推荐");
  expect(next.nextAction?.reasons).not.toContain("适合当前可用时间");
  expect(next.nextAction?.suggestedSliceMinutes).toBe(15);
  expect((await repositories.goals.get(owner, w.goal.id))?.weeklyMinutes).toBe(420);
});
it("keeps the same provider for all calls in a turn while next-turn edits take effect", async () => {
  const { repositories } = setup(); let calls = 0, factories = 0;
  const services = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: seed => {
    factories++;
    return { async complete() {
      calls++;
      if (calls === 1) {
        const setting = await services.settings.get(owner);
        const changed = await services.settings.update(owner, { expectedVersion: setting.version, provider: "qwen" });
        await services.settings.update(owner, { expectedVersion: changed.version, privacyAccepted: true, privacyProvider: "qwen", privacyPolicyVersion: "2026-09-24" });
        return { text: "", toolCalls: [{ id: randomUUID(), name: "get_goal", argumentsJson: JSON.stringify({ goalId: seed.goalId }) }], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "tool_calls" };
      }
      return { text: "仍使用当前轮预设流程。", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" };
    } };
  } });
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "目标" });
  const input = { goalId: goal.id, message: "继续", requestOperationId: randomUUID() };
  expect((await services.agent.processTurn(owner, input)).usage.modelCalls).toBe(2); expect(factories).toBe(1);
  await expect(services.agent.processTurn(owner, { ...input, requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "MODEL_CONFIG_MISSING" });
});
it("pending duplicate admission does not consume a client factory", async () => {
  const { repositories } = setup(); let factories = 0, decorators = 0, release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const services = createServiceContainer({
    repositories,
    env: loadServerEnv({}),
    mockClientFactory: () => { factories++; return { async complete() { started(); await gate; return { text: "完成回复。", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" }; } }; },
    modelClientDecorator: client => { decorators++; return client; },
  });
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "目标" });
  const input = { goalId: goal.id, message: "继续", requestOperationId: randomUUID() };
  const pending = services.agent.processTurn(owner, input); await entered;
  await expect(services.agent.processTurn(owner, input)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect(factories).toBe(1); expect(decorators).toBe(1); release(); await pending;
});
it("interleaved fixture intake and reload use goal-local saved state without global queues", async () => {
  const { services, repositories } = setup();
  const goals = await Promise.all([1, 2].map(() => services.goals.create(owner, { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT })));
  for (const message of [LOCAL_TYPESCRIPT_INPUT, LOCAL_TYPESCRIPT_DONE]) {
    const results = await Promise.all(goals.map(({ goal }) => services.agent.processTurn(owner, { goalId: goal.id, message, requestOperationId: randomUUID() })));
    if (message === LOCAL_TYPESCRIPT_DONE) expect(results[0].draftId).not.toBe(results[1].draftId);
  }
  const reloaded = createServiceContainer({ repositories, env: loadServerEnv({}) });
  for (const { goal } of goals) {
    const w = await reloaded.goals.getWorkspace(owner, goal.id);
    expect(w.pendingDrafts).toHaveLength(1); expect(w.pendingDrafts[0].goalId).toBe(goal.id);
  }
});
it("projects the exact saved reflection across truncation and ignores interleaved or malformed turn records", async () => {
  const { services, repositories } = setup(); const w = await approvedGoal(services);
  expect((await services.goals.getWorkspace(owner, w.goal.id)).reviewReflection).toBeNull();
  const result = await services.agent.processTurn(owner, { goalId: w.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
  expect(result.message).toContain("已完成 0 项"); expect(result.message).toContain("提交证据 0 条");
  for (let i = 0; i < 7; i++) await services.agent.processTurn(owner, { goalId: w.goal.id, message: `继续 ${i}`, requestOperationId: randomUUID() });
  const summary = await repositories.conversations.getSummary(owner, w.goal.id);
  expect(summary?.content.length).toBeGreaterThan(0); expect(summary!.content.length).toBeLessThanOrEqual(1500);
  let projected = await services.goals.getWorkspace(owner, w.goal.id);
  expect(projected.conversation.recentMessages).toHaveLength(6);
  expect(projected.conversation.recentMessages.some(message => message.content === GOAL_REVIEW_REQUEST_MESSAGE)).toBe(false);
  expect(projected.reviewReflection).toEqual({ message: result.message, generatedAt: "2026-09-04T16:01:00.000Z", stale: false });

  const hash = contentHash({ goalId: w.goal.id, userMessage: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true });
  const later = await repositories.support.createOperation(owner, { goalId: w.goal.id, operationId: `agent-turn:${randomUUID()}`, toolName: "agent_turn", parameterHash: hash });
  await repositories.support.updateOperation(owner, later.id, later.version, { status: "succeeded", result: { schemaVersion: 1, kind: "agent_turn", phase: "done", outcome: { ok: true, data: { ...result, message: "按插入顺序选中的后续复盘。" } } } });
  const malformed = await repositories.support.createOperation(owner, { goalId: w.goal.id, operationId: `agent-turn:${randomUUID()}`, toolName: "agent_turn", parameterHash: hash });
  await repositories.support.updateOperation(owner, malformed.id, malformed.version, { status: "succeeded", result: { schemaVersion: 1, kind: "agent_turn", phase: "done", outcome: { ok: true, data: { message: "缺少字段" } } } });
  const failed = await repositories.support.createOperation(owner, { goalId: w.goal.id, operationId: `agent-turn:${randomUUID()}`, toolName: "agent_turn", parameterHash: hash });
  await repositories.support.updateOperation(owner, failed.id, failed.version, { status: "failed", result: { schemaVersion: 1, kind: "agent_turn", phase: "done", outcome: { ok: false, failure: { code: "MODEL_TIMEOUT", status: 504, state: "reviewing", persistedChange: false } } } });
  await repositories.support.createOperation(owner, { goalId: w.goal.id, operationId: `agent-turn:${randomUUID()}`, toolName: "agent_turn", parameterHash: hash });
  const other = await approvedGoal(services);
  await services.agent.processTurn(owner, { goalId: other.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
  projected = await services.goals.getWorkspace(owner, w.goal.id);
  expect(projected.reviewReflection).toEqual({ message: "按插入顺序选中的后续复盘。", generatedAt: "2026-09-04T16:01:00.000Z", stale: false });
});

it("removes saved reflection operations with goal deletion and full clear", async () => {
  const { services, repositories } = setup();
  let w = await approvedGoal(services);
  await services.agent.processTurn(owner, { goalId: w.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
  expect((await repositories.support.listSucceededAgentTurnOperations(owner, w.goal.id)).length).toBeGreaterThan(0);
  await services.goals.remove(owner, w.goal.id, { source: "ui_confirmation", confirmationPhrase: w.goal.title, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  expect(await repositories.support.listSucceededAgentTurnOperations(owner, w.goal.id)).toEqual([]);

  w = await approvedGoal(services);
  await services.agent.processTurn(owner, { goalId: w.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
  const setting = await services.settings.get(owner);
  await services.data.clear(owner, { confirmationPhrase: "清除我的全部本地数据", expectedSettingId: setting.id, operationId: randomUUID() });
  expect(await repositories.support.listSucceededAgentTurnOperations(owner, w.goal.id)).toEqual([]);
});
it("model completion needs already persisted matching evidence and never submits its own", async () => {
  const { services, repositories } = setup(); let w = await approvedGoal(services);
  const clientFor = () => new MockModelClient([{ text: "", toolCalls: [{ id: randomUUID(), name: "update_task_status", argumentsJson: JSON.stringify({ goalId: w.goal.id, taskId: w.tasks[0].id, expectedTaskVersion: w.tasks[0].version, status: "done" }) }], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "tool_calls" }, { text: "状态已更新。", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" }]);
  const injected = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: clientFor });
  await expect(injected.agent.processTurn(owner, { goalId: w.goal.id, message: "标记完成", explicitIntent: true, requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  const failed = (await repositories.goals.get(owner, w.goal.id))!;
  await repositories.goals.update(owner, failed.id, failed.version, { agentState: "active" });
  await repositories.support.createTaskEvidence(owner, { goalId: w.goal.id, taskId: w.tasks[0].id, type: "text", text: "真实用户已提交的记录", fileName: null, fileSize: null, mimeType: null });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  await injected.agent.processTurn(owner, { goalId: w.goal.id, message: "标记完成", explicitIntent: true, requestOperationId: randomUUID() });
  const after = await services.goals.getWorkspace(owner, w.goal.id);
  expect(after.tasks[0].status).toBe("done"); expect(after.evidence).toHaveLength(1);
  await services.tasks.update(owner, after.tasks[0].id, { ...executionInput(after), status: "doing" }, "ui_explicit");
  expect((await services.goals.getWorkspace(owner, w.goal.id)).evidence).toHaveLength(1);
});
it("paused repeated proposals supersede only pending candidates and rejection keeps pause", async () => {
  const { services, repositories } = setup(); let w = await approvedGoal(services);
  await services.goals.changeStatus(owner, w.goal.id, { status: "paused", expectedVersion: w.goal.version, operationId: randomUUID() });
  let previous = "";
  for (let i = 0; i < 2; i++) {
    w = await services.goals.getWorkspace(owner, w.goal.id);
    const draft = await services.plans.createManualDraft(owner, { goalId: w.goal.id, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, changeReason: "修改", tasks: w.tasks.map((t, index) => ({ ...TaskCreateInputSchema.strip().parse(t), title: index === 0 ? `修改${i}` : t.title })), operationId: randomUUID() });
    if (previous) expect((await repositories.plans.getDraftArtifact(owner, previous))!.status).toBe("superseded");
    previous = draft.id;
    expect((await services.goals.getWorkspace(owner, w.goal.id)).pendingDrafts).toHaveLength(1);
  }
  w = await services.goals.getWorkspace(owner, w.goal.id);
  await services.plans.rejectReplan(owner, { goalId: w.goal.id, draftId: previous, expectedDraftVersion: 1, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).goal).toMatchObject({ status: "paused", agentState: "paused" });
});
it("late plan approval failure rolls back grants, plans, pause restoration and draft status", async () => {
  const { services, db } = setup(); let w = await approvedGoal(services);
  await services.goals.changeStatus(owner, w.goal.id, { status: "paused", expectedVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const draft = await services.plans.createManualDraft(owner, { goalId: w.goal.id, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, changeReason: "更新标题", tasks: w.tasks.map((t, i) => ({ ...TaskCreateInputSchema.strip().parse(t), title: i === 1 ? "新任务名" : t.title })), operationId: randomUUID() });
  const before = await services.goals.getWorkspace(owner, w.goal.id);
  const grants = db.$client.prepare("SELECT count(*) AS n FROM approval_grants").get();
  db.$client.exec("CREATE TRIGGER reject_plan_audit BEFORE INSERT ON audit_events WHEN NEW.type = 'tool_executed' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await expect(services.approvals.approve(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() })).rejects.toBeDefined();
  expect(await services.goals.getWorkspace(owner, w.goal.id)).toEqual(before);
  expect(db.$client.prepare("SELECT count(*) AS n FROM approval_grants").get()).toEqual(grants);
});
it("superseded task updates are conflicts and pending legacy contracts fail closed", async () => {
  const { services, repositories } = setup(); const w = await approvedGoal(services);
  const last = w.tasks[2];
  await services.tasks.remove(owner, last.id, { goalId: w.goal.id, source: "ui_confirmation", confirmationPhrase: last.title, expectedTaskVersion: last.version, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  const next = await services.goals.getWorkspace(owner, w.goal.id);
  await expect(services.tasks.update(owner, w.tasks[0].id, { ...executionInput(next), expectedVersion: w.tasks[0].version, status: "doing" }, "ui_explicit")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "目标" });
  const legacy = { schemaVersion: 1, baseGoalVersion: goal.version, contract };
  await repositories.plans.saveDraftArtifact(owner, { goalId: goal.id, kind: "goal_contract", payload: legacy, contentHash: contentHash(legacy) });
  await expect(services.goals.getWorkspace(owner, goal.id)).rejects.toBeDefined();
});
it("new evidence repository writes reject mixed text and metadata shapes", async () => {
  const { services, repositories } = setup(); const w = await approvedGoal(services);
  const base = { goalId: w.goal.id, taskId: w.tasks[0].id };
  for (const value of [{ type: "text", text: "结果", fileName: "a", fileSize: null, mimeType: null }, { type: "file_metadata", text: "混合", fileName: "a", fileSize: 1, mimeType: "text/plain" }])
    await expect(repositories.support.createTaskEvidence(owner, { ...base, ...value } as never)).rejects.toBeDefined();
  expect((await services.goals.getWorkspace(owner, w.goal.id)).evidence).toEqual([]);
});
it("unsupported offline intake can bootstrap a user-authored contract without a model call", async () => {
  const { repositories } = setup(); let calls = 0;
  const services = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => { calls++; throw new Error("Unexpected model"); } });
  const { goal } = await services.goals.create(owner, { category: "light_work", initialMessage: "整理工作目录" });
  const input = { expectedGoalVersion: goal.version, contract: { ...contract, title: goal.title, category: "light_work", desiredOutcome: null, definitionOfDone: null }, operationId: randomUUID() };
  const draft = await services.goals.saveContractDraft(owner, goal.id, input);
  expect(await services.goals.saveContractDraft(owner, goal.id, input)).toEqual(draft);
  expect(calls).toBe(0);
  const w = await services.goals.getWorkspace(owner, goal.id);
  expect(w.pendingDrafts).toHaveLength(1); expect(w.goal.desiredOutcome).toBeNull();
  expect(GoalContractDraftPayloadSchema.parse(draft.payload).assumptions).toHaveLength(4);
  await expect(services.approvals.approve(owner, { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_contract", operationId: randomUUID() })).rejects.toBeDefined();
  await expect(services.goals.saveContractDraft(owner, goal.id, { ...input, operationId: randomUUID(), expectedGoalVersion: w.goal.version })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const edited = await services.goals.saveContractDraft(owner, goal.id, { draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: w.goal.version, contract: { ...GoalContractDraftPayloadSchema.parse(draft.payload).contract, desiredOutcome: "目录有序", definitionOfDone: "文件均归类" }, operationId: randomUUID() });
  expect(edited.id).not.toBe(draft.id); expect(calls).toBe(0);
  expect(await services.goals.saveContractDraft(owner, goal.id, input)).toEqual(draft);
  expect((await services.goals.getWorkspace(owner, goal.id)).pendingDrafts.map(d => d.id)).toEqual([edited.id]);
});
it("manual bootstrap works at the clarification cap and refuses stale preparation", async () => {
  const { services, repositories } = setup();
  let { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "自定学习目标" });
  goal = await repositories.goals.update(owner, goal.id, goal.version, { agentState: "clarifying", clarificationCount: 3 });
  const input = { expectedGoalVersion: goal.version, contract: { ...contract, title: goal.title }, operationId: randomUUID() };
  await expect(services.goals.saveContractDraft(owner, goal.id, { ...input, expectedGoalVersion: goal.version - 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const draft = await services.goals.saveContractDraft(owner, goal.id, input);
  expect(GoalContractDraftPayloadSchema.parse(draft.payload).baseGoalVersion).toBe(goal.version + 1);
  expect((await services.goals.getWorkspace(owner, goal.id)).goal.clarificationCount).toBe(3);
});
it("prepares disclosed defaults once on the Shanghai date, stamps review version and approves complete draft", async () => {
  const { repositories, services } = setup();
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "TypeScript" });
  const draft = await repositories.withTransaction(tx => persistContractDraft(tx, owner, { goalId: goal.id, expectedGoalVersion: goal.version, contract, assumptions: [] }, new Date("2026-09-04T16:01:00Z")));
  const payload = GoalContractDraftPayloadSchema.parse(draft.payload);
  expect(payload.contract).toMatchObject({ deadline: "2026-10-03", weeklyMinutes: 60, constraints: [], motivation: "先完成这个目标，再根据实际进展调整。" });
  expect(payload.assumptions.map(a => a.field)).toEqual(["deadline", "weeklyMinutes", "constraints", "motivation"]);
  expect(draft.contentHash).toBe(contentHash(payload));
  expect(await repositories.goals.get(owner, goal.id)).toMatchObject({ status: "draft", agentState: "contract_review", version: payload.baseGoalVersion, desiredOutcome: null });
  const input = { goalId: goal.id, draftId: draft.id, toolName: "save_approved_contract" as const, expectedDraftVersion: draft.version, operationId: randomUUID() };
  const approved = await services.approvals.approve(owner, input);
  expect(approved).toMatchObject({ goal: { agentState: "planning", desiredOutcome: "做一个待办网页", deadline: "2026-10-03" } });
  expect(await services.approvals.approve(owner, input)).toEqual(approved);
});
it("saves immutable contract edits idempotently, retains unchanged assumptions and rejects old approval", async () => {
  const { repositories, services } = setup();
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "TypeScript" });
  const draft = await repositories.withTransaction(tx => persistContractDraft(tx, owner, { goalId: goal.id, expectedGoalVersion: 1, contract, assumptions: [] }, new Date("2026-09-04T15:59:00Z")));
  const old = GoalContractDraftPayloadSchema.parse(draft.payload);
  expect(old.contract.deadline).toBe("2026-10-02");
  const input = { draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: old.baseGoalVersion, contract: { ...old.contract, weeklyMinutes: 120 }, operationId: randomUUID() };
  const replacement = await services.goals.replaceContractDraft(owner, goal.id, input);
  expect(await services.goals.replaceContractDraft(owner, goal.id, input)).toEqual(replacement);
  expect(GoalContractDraftPayloadSchema.parse(replacement.payload).assumptions.map(a => a.field)).toEqual(["deadline", "constraints", "motivation"]);
  expect((await services.goals.getWorkspace(owner, goal.id)).pendingDrafts.map(d => d.id)).toEqual([replacement.id]);
  expect(await repositories.goals.get(owner, goal.id)).toMatchObject({ desiredOutcome: null, weeklyMinutes: null });
  await expect(services.approvals.approve(owner, { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_contract", operationId: randomUUID() })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
it("refuses incomplete critical contract approval with atomic grant and operation rollback", async () => {
  const { db, repositories, services } = setup();
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "TypeScript" });
  const draft = await repositories.withTransaction(tx => persistContractDraft(tx, owner, { goalId: goal.id, expectedGoalVersion: 1, contract: { ...contract, definitionOfDone: null }, assumptions: [] }, new Date()));
  await expect(services.approvals.approve(owner, { goalId: goal.id, draftId: draft.id, expectedDraftVersion: 1, toolName: "save_approved_contract", operationId: randomUUID() })).rejects.toBeDefined();
  expect(db.$client.prepare("SELECT count(*) AS n FROM approval_grants").get()).toEqual({ n: 0 });
  expect(db.$client.prepare("SELECT count(*) AS n FROM operations").get()).toEqual({ n: 0 });
});
it("creates a trimmed intake goal without accepting browser-managed state", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const services = createServiceContainer({ repositories: createRepositories(db), env: loadServerEnv({}) });
  const created = await services.goals.create(LOCAL_OWNER_ID, { category: "learning", initialMessage: " 三个月学会 TypeScript " });
  expect(created).toMatchObject({ state: "intake", goal: { title: "三个月学会 TypeScript", status: "draft", agentState: "intake", clarificationCount: 0, currentPlanVersionId: null, desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null } });
  await expect(services.goals.create(LOCAL_OWNER_ID, { category: "learning", initialMessage: "x", ownerId: LOCAL_OWNER_ID } as never)).rejects.toBeDefined();
});
