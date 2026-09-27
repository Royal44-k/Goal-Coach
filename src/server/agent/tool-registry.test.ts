import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { modelToolDefinitions, toolRegistry, type ToolName } from "./tool-registry";
import { GoalContractDraftPayloadSchema } from "./tool-contracts";
import { PlanRevisionPayloadSchema } from "../repositories/revision-contracts";
import { contentHash } from "../security/canonical-json";

it("seals v2 field-linked assumptions and rejects legacy or deceptive annotations", () => {
  const contract = { title: "目标", category: "learning", desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: 60, constraints: [], motivation: "兴趣" };
  const payload = { schemaVersion: 2, baseGoalVersion: 1, contract, assumptions: [{ field: "weeklyMinutes", reason: " 暂定供确认 " }] };
  expect(GoalContractDraftPayloadSchema.parse(payload).assumptions).toEqual([{ field: "weeklyMinutes", reason: "暂定供确认" }]);
  for (const assumptions of [[{ field: "deadline", reason: "暂定" }], [{ field: "weeklyMinutes", reason: " " }], [...payload.assumptions, ...payload.assumptions], [{ field: "weeklyMinutes", reason: "暂定", value: 60 }]])
    expect(GoalContractDraftPayloadSchema.safeParse({ ...payload, assumptions }).success).toBe(false);
  expect(GoalContractDraftPayloadSchema.safeParse({ ...payload, schemaVersion: 1 }).success).toBe(false);
  expect(contentHash(payload)).not.toBe(contentHash({ ...payload, assumptions: [] }));
});

it("seals ordered roadmap checkpoints and rejects empty, duplicate and legacy lists", () => {
  const payload = { schemaVersion: 2, base: { planVersionId: null, goalVersion: 1 }, changeReason: null, changeSource: "agent", milestones: ["基础", "应用"], tasks: [], executionResets: [], diff: { added: [], removed: [], moved: [], changed: [] } };
  expect(PlanRevisionPayloadSchema.safeParse(payload).success).toBe(true);
  for (const milestones of [undefined, [], [" "], ["基础", " 基础 "]])
    expect(PlanRevisionPayloadSchema.safeParse({ ...payload, milestones }).success).toBe(false);
  expect(PlanRevisionPayloadSchema.safeParse({ ...payload, schemaVersion: 1 }).success).toBe(false);
  expect(contentHash(payload)).not.toBe(contentHash({ ...payload, milestones: ["应用", "基础"] }));
});
it("advertises paused plan approval centrally without exposing it to models", () => {
  expect(toolRegistry.save_approved_plan.allowedStates).toContain("paused");
  expect(modelToolDefinitions().map(t => t.name)).not.toContain("save_approved_plan");
});
it("normalizes optional blank diagnosis notes before canonical validation", () => {
  const result = toolRegistry.diagnose_blocker.argsSchema.parse({ goalId: randomUUID(), taskId: null, blockerCategory: "cannot_start", note: "  ", advice: { minimumNextStep: "打开文件", explanation: "先开始" } });
  expect(result.note).toBeNull();
});

it("provides all 15 strict contracts and excludes every protected tool from model definitions", () => {
  const goalId = randomUUID();
  const taskId = randomUUID();
  const contract = { title: "目标", category: "learning", desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
  const payload = { schemaVersion: 2, milestones: ["基础", "应用"], base: { planVersionId: null, goalVersion: 1 }, changeReason: null, changeSource: "agent", tasks: [], executionResets: [], diff: { added: [], removed: [], moved: [], changed: [] } };
  const approval = { goalId, draftId: randomUUID(), expectedDraftVersion: 1 };
  const valid: Record<ToolName, object> = {
    get_goal: { goalId }, list_tasks: { goalId }, get_progress: { goalId },
    create_goal_contract_draft: { goalId, expectedGoalVersion: 1, assumptions: [], contract },
    create_plan_draft: { goalId, payload }, propose_replan: { goalId, payload },
    diagnose_blocker: { goalId, taskId: null, blockerCategory: "cannot_start", note: null, advice: { minimumNextStep: "打开书", explanation: "开始" } },
    record_check_in: { goalId, taskId: null, kind: "progress", note: "开始阅读", blockerCategory: null, minutesSpent: null, availableWeeklyMinutes: null, expectedGoalVersion: 1 },
    update_task_status: { goalId, taskId, expectedTaskVersion: 1, status: "doing" },
    undo_last_change: { goalId }, save_approved_contract: approval, save_approved_plan: approval,
    delete_task: { goalId, taskId, expectedTaskVersion: 1, expectedGoalVersion: 1, confirmation: "任务" },
    delete_goal: { goalId, expectedGoalVersion: 1, confirmation: "目标" },
    clear_all_data: { expectedSettingId: randomUUID(), confirmation: "清除全部数据" },
  };
  expect(Object.keys(toolRegistry)).toHaveLength(15);
  for (const definition of Object.values(toolRegistry)) {
    expect(definition.argsSchema).toBeDefined();
    expect(definition.resultSchema).toBeDefined();
    expect(["read", "draft", "reversible", "structural", "destructive"]).toContain(definition.permissionClass);
    expect(definition.description).toMatch(/[\u4e00-\u9fff]/);
    expect(definition.argsSchema.safeParse(valid[definition.name]).success).toBe(true);
    for (const untrusted of [{ ownerId: randomUUID() }, { source: "ui_confirmation" }, { state: "active" }, { approvalGrantId: randomUUID() }])
      expect(definition.argsSchema.safeParse({ ...valid[definition.name], ...untrusted }).success).toBe(false);
  }
  expect(GoalContractDraftPayloadSchema.safeParse({ schemaVersion: 2, assumptions: [], baseGoalVersion: 1, contract }).success).toBe(true);
  expect(GoalContractDraftPayloadSchema.safeParse(contract).success).toBe(false);
  const definitions = modelToolDefinitions();
  expect(definitions.map(d => d.name)).toEqual([
    "get_goal", "list_tasks", "get_progress", "create_goal_contract_draft", "create_plan_draft",
    "diagnose_blocker", "propose_replan", "record_check_in", "update_task_status", "undo_last_change",
  ]);
  for (const definition of definitions) {
    expect(definition.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
  }
  expect(definitions.find(definition => definition.name === "create_goal_contract_draft")!.inputSchema)
    .toMatchObject({ properties: { assumptions: { description: expect.stringContaining("contract[field] is non-null") } } });
});

it("uses canonical revision validation and rejects task execution mass assignment", () => {
  const goalId = randomUUID();
  const id = randomUUID();
  const task = { id, title: "阅读", action: "读一页", doneCriteria: "复述", evidenceType: "text", estimateMinutes: 15, dueAt: null, dependencyIds: [] };
  const payload = { schemaVersion: 2, milestones: ["基础", "应用"], base: { planVersionId: null, goalVersion: 1 }, changeReason: null, changeSource: "agent", tasks: [task], executionResets: [], diff: { added: [id], removed: [], moved: [], changed: [] } };
  expect(toolRegistry.create_plan_draft.argsSchema.safeParse({ goalId, payload }).success).toBe(true);
  expect(toolRegistry.propose_replan.argsSchema.safeParse({ goalId, payload: { ...payload, tasks: [task, task] } }).success).toBe(false);
  expect(toolRegistry.create_plan_draft.argsSchema.safeParse({ goalId, payload: { ...payload, tasks: [{ ...task, status: "done" }] } }).success).toBe(false);
  expect(toolRegistry.update_task_status.argsSchema.safeParse({ goalId, taskId: id, expectedTaskVersion: 1, status: "done", actualMinutes: 15, title: "偷偷改结构" }).success).toBe(false);
});

it("accepts minutes-only/status-only patches, typed contract snapshots and advice without a structural draft", () => {
  const goalId = randomUUID();
  const taskId = randomUUID();
  const target = { goalId, taskId, expectedTaskVersion: 1 };
  expect(toolRegistry.update_task_status.argsSchema.safeParse({ ...target, status: "doing" }).success).toBe(true);
  expect(toolRegistry.update_task_status.argsSchema.safeParse({ ...target, actualMinutes: 5 }).success).toBe(true);
  expect(toolRegistry.update_task_status.argsSchema.safeParse(target).success).toBe(false);
  const advice = { taskId, blockerCategory: "cannot_start", minimumNextStep: "打开书", explanation: "先降低开始的难度" };
  expect(toolRegistry.diagnose_blocker.argsSchema.safeParse({ goalId, taskId, blockerCategory: advice.blockerCategory, note: null, advice: { minimumNextStep: advice.minimumNextStep, explanation: advice.explanation } }).success).toBe(true);
  expect(toolRegistry.diagnose_blocker.resultSchema.safeParse({ advice }).success).toBe(true);
  expect(toolRegistry.diagnose_blocker.resultSchema.safeParse({ draft: {} }).success).toBe(false);
});

it("requires a clear request to bind the displayed workspace setting ID", () => {
  expect(toolRegistry.clear_all_data.argsSchema.safeParse({ confirmation: "清除全部数据" }).success).toBe(false);
  expect(toolRegistry.clear_all_data.argsSchema.safeParse({ confirmation: "清除全部数据", expectedSettingId: randomUUID() }).success).toBe(true);
});
