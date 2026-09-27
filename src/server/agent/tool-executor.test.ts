import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, expectTypeOf, it } from "vitest";
import type { Goal } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import { calculateProgress } from "@/core/planning/progress";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { ApprovalService } from "../security/approval-service";
import { OperationService } from "../operations/operation-service";
import { UndoService } from "../operations/undo-service";
import { AuditService } from "../audit/audit-service";
import { ToolExecutor, type ToolHandlers, type TrustedToolContext, type ApprovalReviewers, type MutationToolContext } from "./tool-executor";
import { toolRegistry } from "./tool-registry";
import { contentHash } from "../security/canonical-json";
import type { PlanRevisionPayload } from "../repositories/revision-contracts";

const ownerId = LOCAL_OWNER_ID;
const contract = { title: "私有目标", category: "learning" as const, desiredOutcome: "理解", definitionOfDone: "能复述", deadline: "2026-12-31", weeklyMinutes: 60, constraints: [], motivation: "兴趣" };
const settingInput = { privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null, provider: "mock" as const, model: "mock", fallbackEnabled: false, dailyInputTokenLimit: 100, dailyOutputTokenLimit: 100 };
let db: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
let goal: Goal;
let context: TrustedToolContext;
let approvals: ApprovalService;
const unused = () => { throw new Error("Unexpected test handler"); };
const defaults: ToolHandlers = {
  get_goal: unused, list_tasks: unused, get_progress: unused, create_goal_contract_draft: unused,
  create_plan_draft: unused, diagnose_blocker: unused, propose_replan: unused, record_check_in: unused,
  update_task_status: unused, undo_last_change: unused, save_approved_contract: unused,
  save_approved_plan: unused, delete_task: unused, delete_goal: unused, clear_all_data: unused,
};
function executor(handlers: Partial<ToolHandlers> = {}, reviewers: ApprovalReviewers = {}) {
  return new ToolExecutor({ repositories, operations: new OperationService(repositories), approvals,
    audit: new AuditService(repositories.support), undo: new UndoService(repositories),
    handlers: { ...defaults, ...handlers }, approvalReviewers: reviewers });
}
beforeEach(async () => {
  db = createDatabase(":memory:");
  migrateDatabase(db);
  repositories = createRepositories(db);
  approvals = new ApprovalService(repositories.support);
  goal = await repositories.goals.create(ownerId, contract);
  context = { ownerId, source: "model", goalId: goal.id, operationId: "call:1" };
});
afterEach(() => db?.$client.close());

async function initialPlan(target = goal) {
  const id = randomUUID();
  const payload: PlanRevisionPayload = { schemaVersion: 2, milestones: ["基础", "应用"], base: { planVersionId: null, goalVersion: target.version }, changeReason: null, changeSource: "user", tasks: [{ id, title: "任务", action: "阅读", doneCriteria: "复述", evidenceType: "text", estimateMinutes: 15, dueAt: null, dependencyIds: [] }], executionResets: [], diff: { added: [id], removed: [], moved: [], changed: [] } };
  const draft = await repositories.plans.saveDraftArtifact(ownerId, { goalId: target.id, kind: "plan", payload, contentHash: contentHash(payload) });
  const plan = await repositories.plans.createDraft(ownerId, target.id, { draftArtifactId: draft.id, expectedDraftArtifactVersion: draft.version });
  const approved = await repositories.plans.approve(ownerId, plan.id, plan.version);
  return (await repositories.tasks.listByGoal(ownerId, target.id, approved.id))[0];
}

it.each(["get_goal", "create_goal_contract_draft"] as const)("rejects a stale context fence before executing %s", async toolName => {
  let executed = false;
  const tools = executor({
    get_goal: () => { executed = true; return { goal }; },
    create_goal_contract_draft: (args, ctx) => {
      executed = true;
      return toolRegistry.create_goal_contract_draft.resultSchema.parse({ draft: ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload: { schemaVersion: 2, assumptions: [], baseGoalVersion: goal.version, contract }, contentHash: "a".repeat(64) }) });
    },
  });
  const bound = { ...context, expectedFenceRevision: 1 };
  await expect(tools.execute({ toolName, args: toolName === "get_goal" ? { goalId: goal.id } : { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract }, context: bound })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(executed).toBe(false);
  expect(await repositories.support.getOperationByOperationId(ownerId, context.operationId!)).toBeNull();
});

it("parses arguments before source checks and rejects a schema-valid model deletion", async () => {
  const tools = executor();
  await expect(tools.execute({ toolName: "update_task_status", args: { taskId: randomUUID(), status: "invalid" }, context })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(tools.execute({ toolName: "delete_task", args: { goalId: goal.id, taskId: randomUUID(), expectedTaskVersion: 1, expectedGoalVersion: goal.version, confirmation: "私有任务" }, context })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(await repositories.support.getOperationByOperationId(ownerId, context.operationId!)).toBeNull();
});

it("permits async reads through a read-only repository surface with no database", async () => {
  const tools = executor({ get_goal: async (args, ctx) => {
    expect(Object.keys(ctx.repositories)).toEqual(["goals", "tasks", "plans", "support"]);
    expect(ctx.repositories.goals).not.toHaveProperty("update");
    expect(ctx.repositories).not.toHaveProperty("withTransaction");
    expect(ctx).not.toHaveProperty("database");
    return { goal: await ctx.repositories.goals.get(ctx.ownerId, args.goalId) };
  } });
  await expect(tools.execute({ toolName: "get_goal", args: { goalId: goal.id }, context })).resolves.toEqual({ goal });
  expect(await repositories.support.getOperationByOperationId(ownerId, context.operationId!)).toBeNull();
});

it("commits a draft once, replays across state changes, and checks trusted source before replay", async () => {
  let calls = 0;
  const tools = executor({ create_goal_contract_draft: (args, ctx) => {
    calls++;
    expect(ctx.source).toBe("model");
    expect(ctx.repositories).not.toHaveProperty("database");
    expect(ctx.repositories).not.toHaveProperty("withTransaction");
    const draft = ctx.repositories.plans.saveDraftArtifact(ctx.ownerId, { goalId: args.goalId, kind: "goal_contract", payload: { schemaVersion: 2, assumptions: [], baseGoalVersion: args.expectedGoalVersion, contract: args.contract }, contentHash: "a".repeat(64) });
    ctx.repositories.goals.update(ctx.ownerId, goal.id, goal.version, { agentState: "active" });
    return toolRegistry.create_goal_contract_draft.resultSchema.parse({ draft });
  } });
  const request = { toolName: "create_goal_contract_draft" as const, args: { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract }, context };
  const first = await tools.execute(request);
  expect(await tools.execute(request)).toEqual(first);
  expect(calls).toBe(1);
  expect(await repositories.support.listAuditEventsByGoal(ownerId, goal.id)).toMatchObject([{ type: "tool_executed", detail: { toolName: request.toolName, source: "model" } }]);
  await expect(tools.execute({ ...request, context: { ...context, ownerId: randomUUID() } })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(calls).toBe(1);
  await expect(tools.execute({ ...request, context: { ...context, source: "spoofed" as never } })).rejects.toMatchObject({ code: "ORIGIN_REJECTED" });
  await expect(tools.execute({ ...request, args: { ...request.args, expectedGoalVersion: 2 } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(tools.execute({ ...request, context: { ...context, operationId: "new" } })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
});

it("issues and consumes a grant only for a new trusted approval; exact retry needs no subject or fresh grant", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "contract_review" });
  const payload = { schemaVersion: 2 as const, assumptions: [], baseGoalVersion: goal.version, contract };
  const draft = await repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) });
  let reviews = 0;
  let grantId = "";
  const tools = executor({ save_approved_contract: (args, ctx) => {
    const updated = ctx.repositories.goals.update(ownerId, args.goalId, goal.version, { agentState: "planning" });
    return { goal: updated };
  } }, { save_approved_contract: (args, ctx) => {
    reviews++;
    expect(ctx.repositories.plans.getDraftArtifact(ownerId, args.draftId)).toMatchObject({ id: draft.id });
    return { payload: { schemaVersion: 2, assumptions: [], baseGoalVersion: goal.version, contract } };
  } });
  const request = { toolName: "save_approved_contract" as const, args: { goalId: goal.id, draftId: draft.id, expectedDraftVersion: 1 }, context: { ...context, source: "ui_explicit" as const } };
  const first = await tools.execute(request);
  expect(await tools.execute(request)).toEqual(first);
  expect(reviews).toBe(1);
  const row = db.$client.prepare("SELECT id FROM approval_grants").get() as { id: string };
  grantId = row.id;
  expect(await repositories.support.getApprovalGrant(ownerId, grantId)).toMatchObject({ usedAt: expect.any(String), subjectId: draft.id });
  await expect(tools.execute({ ...request, context })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  const current = (await repositories.goals.get(ownerId, goal.id))!;
  await repositories.goals.update(ownerId, goal.id, current.version, { agentState: "contract_review" });
  const reused = executor({ save_approved_contract: unused }, { save_approved_contract: () => ({ payload: { schemaVersion: 2, assumptions: [], baseGoalVersion: goal.version, contract }, grantId }) });
  await expect(reused.execute({ ...request, context: { ...request.context, operationId: "new-approval" } })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
});

it("rolls back writes, grant consumption and operation when output fails validation", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "contract_review" });
  const payload = { schemaVersion: 2 as const, assumptions: [], baseGoalVersion: goal.version, contract };
  const draftId = (await repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) })).id;
  const grant = await approvals.issue({ ownerId, subjectId: draftId, toolName: "save_approved_contract", payload });
  const tools = executor({ save_approved_contract: ((_args: unknown, ctx: MutationToolContext) => {
    ctx.repositories.goals.update(ownerId, goal.id, goal.version, { title: "不应提交" });
    return { goal: null };
  }) as unknown as ToolHandlers["save_approved_contract"] }, { save_approved_contract: () => ({ payload, grantId: grant.id }) });
  await expect(tools.execute({ toolName: "save_approved_contract", args: { goalId: goal.id, draftId, expectedDraftVersion: 1 }, context: { ...context, source: "ui_explicit" } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await repositories.goals.get(ownerId, goal.id)).toEqual(goal);
  expect(await repositories.support.getApprovalGrant(ownerId, grant.id)).toMatchObject({ usedAt: null, version: 1 });
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
  expect(await repositories.support.listAuditEventsByGoal(ownerId, goal.id)).toEqual([]);
});

it("rejects and observes a thenable before result parsing hides it and expires its facade", async () => {
  let completion!: Promise<unknown>;
  const tools = executor({ create_goal_contract_draft: ((_args: unknown, ctx: MutationToolContext) => {
    completion = (async () => {
      ctx.repositories.goals.update(ownerId, goal.id, goal.version, { title: "早写入" });
      await Promise.resolve();
      ctx.repositories.goals.update(ownerId, goal.id, goal.version + 1, { title: "晚写入" });
      return { draft: null };
    })();
    return completion;
  }) as unknown as ToolHandlers["create_goal_contract_draft"] });
  await expect(tools.executeObserved({ toolName: "create_goal_contract_draft", args: { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract }, context })).rejects.toMatchObject({ code: "VALIDATION_ERROR", internalMessage: "Mutation handlers must be synchronous" });
  await expect(completion).rejects.toBeDefined();
  expect(await repositories.goals.get(ownerId, goal.id)).toEqual(goal);
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
});

it("deletes with a null-goal minimal audit and replays after the goal and subject have gone", async () => {
  const tools = executor({ delete_goal: (args, ctx) => {
    ctx.repositories.goals.delete(ownerId, args.goalId);
    return { deletedGoalId: args.goalId };
  } }, { delete_goal: args => ({ payload: args }) });
  const request = { toolName: "delete_goal" as const, args: { goalId: goal.id, expectedGoalVersion: goal.version, confirmation: contract.title }, context: { ...context, source: "ui_confirmation" as const } };
  expect(await tools.execute(request)).toEqual({ deletedGoalId: goal.id });
  expect(await tools.execute(request)).toEqual({ deletedGoalId: goal.id });
  expect(await repositories.goals.get(ownerId, goal.id)).toBeNull();
  const audits = db.$client.prepare("SELECT * FROM audit_events").all();
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ goal_id: null, entity_id: goal.id });
  expect(JSON.stringify(audits)).not.toContain(contract.title);
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toMatchObject({ goalId: null });
});

it("clears without an active goal or post-clear audit and replays its sole count tombstone", async () => {
  const settings = await repositories.support.createAppSetting(ownerId, settingInput);
  const tools = executor({ clear_all_data: (_args, ctx) => {
    const deletedCounts = ctx.repositories.support.clearOwnerData(ownerId, ctx.operation.id);
    ctx.repositories.support.createAppSetting(ownerId, settingInput);
    return { deletedCounts };
  } }, { clear_all_data: (args, ctx) => {
    if (ctx.repositories.support.getSettingsByOwner(ownerId)?.id !== args.expectedSettingId)
      throw new AppError("VERSION_CONFLICT", 409, "Workspace generation changed");
    return { payload: args };
  } });
  const request = { toolName: "clear_all_data" as const, args: { confirmation: "清除全部数据", expectedSettingId: settings.id }, context: { ownerId, source: "ui_confirmation" as const, operationId: "clear:1" } };
  const first = await tools.execute(request);
  expect(first.deletedCounts.goals).toBe(1);
  expect(await tools.execute(request)).toEqual(first);
  expect(db.$client.prepare("SELECT * FROM audit_events").all()).toEqual([]);
  expect(db.$client.prepare("SELECT * FROM approval_grants").all()).toEqual([]);
  expect(db.$client.prepare("SELECT * FROM operations").all()).toHaveLength(1);
  expect(JSON.stringify(await repositories.support.getOperationByOperationId(ownerId, "clear:1"))).not.toContain(request.args.confirmation);
  const nextSettings = (await repositories.support.getSettingsByOwner(ownerId))!;
  await tools.execute({ ...request, args: { ...request.args, expectedSettingId: nextSettings.id }, context: { ...request.context, operationId: "clear:2" } });
  expect(await repositories.support.getOperationByOperationId(ownerId, "clear:1")).toBeNull();
  const freshGoal = await repositories.goals.create(ownerId, contract);
  await expect(tools.execute(request)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.goals.get(ownerId, freshGoal.id)).toEqual(freshGoal);
  expect(db.$client.prepare("SELECT * FROM approval_grants").all()).toEqual([]);
});

it("rejects same-owner cross-goal task and draft targets before granting or invoking handlers", async () => {
  await initialPlan();
  const other = await repositories.goals.create(ownerId, contract);
  const otherTask = await initialPlan(other);
  const latestOther = (await repositories.goals.get(ownerId, other.id))!;
  await repositories.goals.update(ownerId, other.id, latestOther.version, { agentState: "paused", status: "paused" });
  const tools = executor();
  await expect(tools.execute({ toolName: "update_task_status", args: { goalId: goal.id, taskId: otherTask.id, expectedTaskVersion: 1, status: "done" }, context: { ...context, source: "ui_explicit" } })).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
  const advice = { minimumNextStep: "开始", explanation: "小步" };
  await expect(tools.execute({ toolName: "diagnose_blocker", args: { goalId: goal.id, taskId: otherTask.id, blockerCategory: "cannot_start", note: null, advice }, context })).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
  const draft = await repositories.plans.saveDraftArtifact(ownerId, { goalId: other.id, kind: "goal_contract", payload: { schemaVersion: 2, assumptions: [], baseGoalVersion: latestOther.version, contract }, contentHash: "a".repeat(64) });
  const current = (await repositories.goals.get(ownerId, goal.id))!;
  await repositories.goals.update(ownerId, goal.id, current.version, { agentState: "contract_review" });
  await expect(tools.execute({ toolName: "save_approved_contract", args: { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version }, context: { ...context, source: "ui_explicit" } })).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
  expect(await repositories.tasks.get(ownerId, otherTask.id)).toEqual(otherTask);
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
});

it("binds reversible writes and undo to the transaction and rejects replay with lost explicit intent", async () => {
  const task = await initialPlan();
  const tools = executor({ update_task_status: (args, ctx) => {
    const before = ctx.repositories.tasks.get(ownerId, args.taskId)!;
    const after = ctx.repositories.tasks.update(ownerId, args.taskId, args.expectedTaskVersion, { status: args.status });
    ctx.undo.recordTaskPatch({ goalId: goal.id, taskId: task.id, before: { status: before.status, actualMinutes: before.actualMinutes }, after: { status: after.status, actualMinutes: after.actualMinutes } });
    return { task: after };
  }, undo_last_change: (args, ctx) => ctx.undo.undoLast(args.goalId, args) });
  const request = { toolName: "update_task_status" as const, args: { goalId: goal.id, taskId: task.id, expectedTaskVersion: task.version, status: "done" }, context: { ...context, explicitIntent: true } };
  expect(await tools.execute(request)).toMatchObject({ task: { status: "done", version: 2 } });
  expect(await tools.execute(request)).toMatchObject({ task: { status: "done", version: 2 } });
  await expect(tools.execute({ ...request, context })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(await tools.execute({ toolName: "undo_last_change", args: { goalId: goal.id }, context: { ...context, source: "ui_explicit", operationId: "undo:1" } })).toMatchObject({ task: { status: "todo", version: 3 } });
  expect(await repositories.support.getLatestPendingUndo(ownerId, goal.id)).toBeNull();
});

it("supports progress, list and advice through async reads without any formal change", async () => {
  const task = await initialPlan();
  const tools = executor({ list_tasks: async (args, ctx) => {
    const plan = (await ctx.repositories.plans.getCurrent(ownerId, args.goalId))!;
    return { tasks: await ctx.repositories.tasks.listByGoal(ownerId, args.goalId, plan.id) };
  }, get_progress: async (args, ctx) => {
    const plan = (await ctx.repositories.plans.getCurrent(ownerId, args.goalId))!;
    return calculateProgress(await ctx.repositories.tasks.listByGoal(ownerId, args.goalId, plan.id));
  }, diagnose_blocker: async (args, ctx) => {
    expect(await ctx.repositories.tasks.get(ownerId, args.taskId!)).toEqual(task);
    expect(await ctx.repositories.support.listCheckInsByGoal(ownerId, args.goalId)).toEqual([]);
    expect(await ctx.repositories.support.listEvidenceByTask(ownerId, task.id)).toEqual([]);
    expect(ctx).not.toHaveProperty("operation");
    return { advice: { taskId: args.taskId, blockerCategory: args.blockerCategory, ...args.advice } };
  } });
  expect(await tools.execute({ toolName: "list_tasks", args: { goalId: goal.id }, context })).toEqual({ tasks: [task] });
  expect(await tools.execute({ toolName: "get_progress", args: { goalId: goal.id }, context })).toEqual({ completed: 0, total: 1, percent: 0 });
  const advice = { minimumNextStep: "打开书", explanation: "减少启动成本" };
  expect(await tools.execute({ toolName: "diagnose_blocker", args: { goalId: goal.id, taskId: task.id, blockerCategory: "cannot_start", note: null, advice }, context })).toEqual({ advice: { taskId: task.id, blockerCategory: "cannot_start", ...advice } });
  expect(await repositories.tasks.get(ownerId, task.id)).toEqual(task);
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
  expect(await repositories.support.listAuditEventsByGoal(ownerId, goal.id)).toEqual([]);
});

it("rejects unknown names, missing mutation IDs, missing subjects and trusted goal substitution", async () => {
  const tools = executor({ get_goal: async (args, ctx) => ({ goal: await ctx.repositories.goals.get(ownerId, args.goalId) }) });
  await expect(tools.execute({ toolName: "__proto__" as never, args: {}, context })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(tools.execute({ toolName: "get_goal", args: { goalId: randomUUID() }, context })).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
  await expect(tools.execute({ toolName: "create_goal_contract_draft", args: { goalId: goal.id, expectedGoalVersion: 1, assumptions: [], contract }, context: { ...context, operationId: undefined } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  const missing = randomUUID();
  expect(await tools.execute({ toolName: "get_goal", args: { goalId: missing }, context: { ...context, goalId: missing } })).toEqual({ goal: null });
  await expect(tools.execute({ toolName: "get_progress", args: { goalId: missing }, context: { ...context, goalId: missing } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(tools.execute({ toolName: "delete_goal", args: { goalId: missing, expectedGoalVersion: 1, confirmation: "删除" }, context: { ...context, goalId: missing, source: "ui_confirmation" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("requires trusted review and rejects missing grants or an asynchronous reviewer atomically", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "contract_review" });
  const payload = { schemaVersion: 2 as const, assumptions: [], baseGoalVersion: goal.version, contract };
  const draft = await repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) });
  const request = { toolName: "save_approved_contract" as const, args: { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version }, context: { ...context, source: "ui_explicit" as const } };
  await expect(executor().execute(request)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  await expect(executor({}, { save_approved_contract: () => ({ payload, grantId: randomUUID() }) }).execute(request)).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  const asyncReviewer = async () => { throw new Error("Rejected invalid review continuation"); };
  await expect(executor({}, { save_approved_contract: asyncReviewer as unknown as ApprovalReviewers["save_approved_contract"] }).execute(request)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
  expect(db.$client.prepare("SELECT * FROM approval_grants").all()).toEqual([]);
});

it("rolls back task and undo writes if a handler returns an invalid result", async () => {
  const task = await initialPlan();
  const beforeGoal = await repositories.goals.get(ownerId, goal.id);
  const tools = executor({ update_task_status: ((_args: unknown, ctx: MutationToolContext) => {
    const changed = ctx.repositories.tasks.update(ownerId, task.id, task.version, { status: "done" });
    ctx.undo.recordTaskPatch({ goalId: goal.id, taskId: task.id, before: { status: task.status, actualMinutes: task.actualMinutes }, after: { status: changed.status, actualMinutes: changed.actualMinutes } });
    return null;
  }) as unknown as ToolHandlers["update_task_status"] });
  await expect(tools.execute({ toolName: "update_task_status", args: { goalId: goal.id, taskId: task.id, expectedTaskVersion: task.version, status: "done" }, context: { ...context, source: "ui_explicit" } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await repositories.tasks.get(ownerId, task.id)).toEqual(task);
  expect(await repositories.goals.get(ownerId, goal.id)).toEqual(beforeGoal);
  expect(await repositories.support.getLatestPendingUndo(ownerId, goal.id)).toBeNull();
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
});

it("rolls back an otherwise valid approval if audit insertion fails", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "contract_review" });
  const payload = { schemaVersion: 2 as const, assumptions: [], baseGoalVersion: goal.version, contract };
  const draft = await repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) });
  db.$client.exec("CREATE TRIGGER reject_tool_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");
  const tools = executor({ save_approved_contract: (_args, ctx) => ({ goal: ctx.repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "planning" }) }) }, { save_approved_contract: () => ({ payload }) });
  await expect(tools.execute({ toolName: "save_approved_contract", args: { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version }, context: { ...context, source: "ui_explicit" } })).rejects.toBeDefined();
  expect(await repositories.goals.get(ownerId, goal.id)).toEqual(goal);
  expect(db.$client.prepare("SELECT * FROM approval_grants").all()).toEqual([]);
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
});

it("checks missing task subjects before read or mutation handlers and binds deletion grants to the task", async () => {
  const task = await initialPlan();
  const tools = executor();
  await expect(tools.execute({ toolName: "update_task_status", args: { goalId: goal.id, taskId: randomUUID(), expectedTaskVersion: 1, status: "done" }, context: { ...context, source: "ui_explicit" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // This injected probe intentionally throws before doing Task 12's successor-plan
  // mutation; only the executor's dedicated task grant composition is under test.
  const deletion = executor({ delete_task: (_args, ctx) => {
    const row = db.$client.prepare("SELECT id FROM approval_grants").get() as { id: string };
    expect(ctx.repositories.support.getApprovalGrant(ownerId, row.id)).toMatchObject({ subjectId: task.id, usedAt: expect.any(String), allowedTool: "delete_task" });
    throw new Error("Stop before business mutation");
  } }, { delete_task: args => ({ payload: args }) });
  const currentGoal = (await repositories.goals.get(ownerId, goal.id))!;
  await expect(deletion.execute({ toolName: "delete_task", args: { goalId: goal.id, taskId: task.id, expectedTaskVersion: task.version, expectedGoalVersion: currentGoal.version, confirmation: task.title }, context: { ...context, source: "ui_confirmation" } })).rejects.toThrow("Stop before business mutation");
  expect(await repositories.tasks.get(ownerId, task.id)).toEqual(task);
  expect(db.$client.prepare("SELECT * FROM approval_grants").all()).toEqual([]);
});

it("gives every mapped handler a repository-only context and forbids async mutation return types", () => {
  type HandlerContext = Parameters<ToolHandlers[keyof ToolHandlers]>[1];
  expectTypeOf<HandlerContext>().not.toHaveProperty("database");
  expectTypeOf<HandlerContext>().not.toHaveProperty("$client");
  expectTypeOf<ToolHandlers["update_task_status"]>().returns.not.toMatchTypeOf<PromiseLike<unknown>>();
  expectTypeOf<ToolHandlers["save_approved_plan"]>().returns.not.toMatchTypeOf<PromiseLike<unknown>>();
});

it("observes read/advice without attributing a concurrent goal write", async () => {
  const tools = executor({ get_goal: async (_args, ctx) => {
    await repositories.goals.update(ownerId, goal.id, goal.version, { title: "并发更新" });
    return { goal: await ctx.repositories.goals.get(ownerId, goal.id) };
  } });
  expect(await tools.executeObserved({ toolName: "get_goal", args: { goalId: goal.id }, context })).toMatchObject({ observation: { disposition: "read", committedDomainMutation: false }, result: { goal: { version: 2 } } });
});

it("observes committed task and bound undo checkpoints, but never claims replay ownership", async () => {
  const task = await initialPlan();
  const before = (await repositories.goals.get(ownerId, goal.id))!;
  const tools = executor({ update_task_status: (args, ctx) => {
    const updated = ctx.repositories.tasks.update(ownerId, task.id, args.expectedTaskVersion, { status: args.status });
    ctx.undo.recordTaskPatch({ goalId: goal.id, taskId: task.id, before: { status: task.status, actualMinutes: null }, after: { status: updated.status, actualMinutes: null } });
    return { task: updated };
  }, undo_last_change: (args, ctx) => ctx.undo.undoLast(args.goalId, args) });
  const request = { toolName: "update_task_status" as const, args: { goalId: goal.id, taskId: task.id, expectedTaskVersion: 1, status: "done" }, context: { ...context, explicitIntent: true } };
  const first = await tools.executeObserved(request);
  expect(first.observation).toEqual({ disposition: "committed", committedDomainMutation: true, goalBefore: { id: goal.id, version: before.version, agentState: "active", status: "active", currentPlanVersionId: before.currentPlanVersionId }, goalAfter: { id: goal.id, version: before.version + 1, agentState: "active", status: "active", currentPlanVersionId: before.currentPlanVersionId } });
  if (first.observation.disposition === "committed") expect(Object.isFrozen(first.observation.goalAfter)).toBe(true);
  const current = (await repositories.goals.get(ownerId, goal.id))!;
  await repositories.goals.update(ownerId, goal.id, current.version, { title: "并发更新" });
  expect(await tools.executeObserved(request)).toEqual({ result: first.result, observation: { disposition: "replayed", committedDomainMutation: false } });
  expect(await tools.execute(request)).toEqual(first.result);
  expect((await repositories.support.getOperationByOperationId(ownerId, "call:1"))!.result).toEqual(first.result);
  const undone = await tools.executeObserved({ toolName: "undo_last_change", args: { goalId: goal.id }, context: { ...context, operationId: "undo-observed", source: "ui_explicit" } });
  expect(undone.observation).toMatchObject({ disposition: "committed", committedDomainMutation: true, goalBefore: { version: before.version + 2 }, goalAfter: { version: before.version + 3 } });
});

it("distinguishes artifact-only writes from materialized plan writes without a Goal version change", async () => {
  const tools = executor({ create_goal_contract_draft: (args, ctx) => {
    const payload = { schemaVersion: 2, assumptions: [], baseGoalVersion: args.expectedGoalVersion, contract: args.contract };
    return toolRegistry.create_goal_contract_draft.resultSchema.parse({ draft: ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) }) });
  } });
  const outcome = await tools.executeObserved({ toolName: "create_goal_contract_draft", args: { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract }, context });
  expect(outcome.observation).toMatchObject({ disposition: "committed", committedDomainMutation: false, goalBefore: { version: 1 }, goalAfter: { version: 1 } });
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "planning" });
  const payload: PlanRevisionPayload = { schemaVersion: 2, milestones: ["基础", "应用"], base: { planVersionId: null, goalVersion: goal.version }, changeReason: null, changeSource: "agent", tasks: [], executionResets: [], diff: { added: [], removed: [], moved: [], changed: [] } };
  const plans = executor({ create_plan_draft: (args, ctx) => {
    const draft = ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "plan", payload: args.payload, contentHash: contentHash(args.payload) });
    ctx.repositories.plans.createDraft(ownerId, goal.id, { draftArtifactId: draft.id, expectedDraftArtifactVersion: draft.version });
    return toolRegistry.create_plan_draft.resultSchema.parse({ draft });
  } });
  expect((await plans.executeObserved({ toolName: "create_plan_draft", args: { goalId: goal.id, payload }, context: { ...context, operationId: "plan:1" } })).observation).toMatchObject({ disposition: "committed", committedDomainMutation: true, goalBefore: { version: goal.version }, goalAfter: { version: goal.version } });
});

it.each(["handler", "result", "audit", "operation"])("publishes no observation and rolls back at %s failure", async failure => {
  if (failure === "audit") db.$client.exec("CREATE TRIGGER reject_observed_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'failure'); END;");
  if (failure === "operation") db.$client.exec("CREATE TRIGGER reject_observed_operation BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT, 'failure'); END;");
  const tools = executor({ create_goal_contract_draft: ((args: ToolArgsForDraft, ctx: MutationToolContext) => {
    ctx.repositories.goals.update(ownerId, goal.id, goal.version, { title: "rollback" });
    if (failure === "handler") throw new Error("failure");
    if (failure === "result") return { draft: null };
    const payload = { schemaVersion: 2, assumptions: [], baseGoalVersion: args.expectedGoalVersion, contract: args.contract };
    return { draft: ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) }) };
  }) as ToolHandlers["create_goal_contract_draft"] });
  await expect(tools.executeObserved({ toolName: "create_goal_contract_draft", args: { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract }, context })).rejects.toBeDefined();
  expect(await repositories.goals.get(ownerId, goal.id)).toEqual(goal);
  expect(await repositories.support.getOperationByOperationId(ownerId, "call:1")).toBeNull();
});
type ToolArgsForDraft = Parameters<ToolHandlers["create_goal_contract_draft"]>[0];

it("reports check-in commit checkpoints and advice remains read-only across a concurrent update", async () => {
  await initialPlan();
  const before = (await repositories.goals.get(ownerId, goal.id))!;
  const tools = executor({ record_check_in: (args, ctx) => {
    const { expectedGoalVersion, ...values } = args;
    if (ctx.repositories.goals.get(ownerId, args.goalId)?.version !== expectedGoalVersion) throw new AppError("VERSION_CONFLICT", 409, "stale check-in");
    return { checkIn: ctx.repositories.support.createCheckIn(ownerId, values) };
  }, diagnose_blocker: async args => {
    const current = (await repositories.goals.get(ownerId, goal.id))!;
    await repositories.goals.update(ownerId, goal.id, current.version, { title: "并发" });
    return { advice: { taskId: args.taskId, blockerCategory: args.blockerCategory, ...args.advice } };
  } });
  const checked = await tools.executeObserved({ toolName: "record_check_in", args: { goalId: goal.id, taskId: null, expectedGoalVersion: before.version, kind: "reflection", blockerCategory: null, note: "继续", minutesSpent: null, availableWeeklyMinutes: null }, context: { ...context, explicitIntent: true } });
  expect(checked.observation).toMatchObject({ disposition: "committed", committedDomainMutation: true, goalBefore: { version: before.version }, goalAfter: { version: before.version + 1 } });
  const advice = await tools.executeObserved({ toolName: "diagnose_blocker", args: { goalId: goal.id, taskId: null, blockerCategory: "cannot_start", note: null, advice: { minimumNextStep: "阅读一页", explanation: "小步" } }, context });
  expect(advice.observation).toEqual({ disposition: "read", committedDomainMutation: false });
});

it("reports owner clear mutations from actual deletion counts including empty-domain clear", async () => {
  const tools = executor({ clear_all_data: (_args, ctx) => ({ deletedCounts: ctx.repositories.support.clearOwnerData(ownerId, ctx.operation.id) }) }, { clear_all_data: args => ({ payload: args }) });
  const request = { toolName: "clear_all_data" as const, args: { confirmation: "清除", expectedSettingId: randomUUID() }, context: { ownerId, source: "ui_confirmation" as const, operationId: "observed-clear" } };
  expect((await tools.executeObserved(request)).observation).toEqual({ disposition: "committed", committedDomainMutation: true, goalBefore: null, goalAfter: null });
  expect((await tools.executeObserved({ ...request, context: { ...request.context, operationId: "empty-observed-clear" } })).observation).toEqual({ disposition: "committed", committedDomainMutation: false, goalBefore: null, goalAfter: null });
});
