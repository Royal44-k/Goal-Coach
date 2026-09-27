import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentState, Goal } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { contentHash } from "../security/canonical-json";
import { OperationService } from "../operations/operation-service";
import { ApprovalService } from "../security/approval-service";
import { AuditService } from "../audit/audit-service";
import { UndoService } from "../operations/undo-service";
import { QWEN_PRIMARY_MODEL, QWEN_FALLBACK_MODEL } from "../config/env";
import { loadServerEnv } from "../config/env";
import { createServiceContainer } from "../services/service-container";
import { makePlanPayload, persistContractDraft, persistPlanDraft } from "../services/draft-preparation";
import { ToolExecutor, type ToolHandlers } from "./tool-executor";
import { ModelRequestSchema, ModelResponseError, type ModelClient, type ModelRequest, type ModelTurn } from "./model-contracts";
import { MockModelClient } from "./mock-model-client";
import { UsageBudgetService } from "./usage-budget";
import { toolRegistry } from "./tool-registry";
import type { PlanRevisionPayload } from "../repositories/revision-contracts";
import { AgentOrchestrator, type ProcessTurnInput } from "./orchestrator";

const ownerId = LOCAL_OWNER_ID;
const contract = { title: "学习", category: "learning" as const, desiredOutcome: "理解", definitionOfDone: "能复述", deadline: "2026-12-31", weeklyMinutes: 60, constraints: [], motivation: "兴趣" };
const settings = { privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null, provider: "mock" as const, model: QWEN_PRIMARY_MODEL, fallbackEnabled: false, dailyInputTokenLimit: 1_000_000, dailyOutputTokenLimit: 100_000 };
let db: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
let goal: Goal;
let input: ProcessTurnInput;
const turn = (text = "你的完成期限是什么？", toolCalls: ModelTurn["toolCalls"] = []): ModelTurn => ({ text, toolCalls, usage: { inputTokens: 10, outputTokens: 4 }, finishReason: toolCalls.length ? "tool_calls" : "stop" });
const call = (name: string, args: unknown, id = randomUUID()) => ({ name, id, argumentsJson: JSON.stringify(args) });
const proposalOf = (payload: PlanRevisionPayload) => ({ base: payload.base, milestones: payload.milestones,
  changeReason: payload.changeReason, tasks: payload.tasks });
const planTasks = () => [1, 2, 3].map(index => ({ id: randomUUID(), title: `任务${index}`, action: "完成步骤",
  doneCriteria: "提交结果", evidenceType: "text" as const, estimateMinutes: 30, dueAt: null, dependencyIds: [] as string[] }));
const taskInput = (task: PlanRevisionPayload["tasks"][number]) => ({ id: task.id, title: task.title, action: task.action,
  doneCriteria: task.doneCriteria, evidenceType: task.evidenceType, estimateMinutes: task.estimateMinutes,
  dueAt: task.dueAt, dependencyIds: task.dependencyIds });
const timeout = () => new AppError("MODEL_TIMEOUT", 504, "Provider timeout");
const unused = () => { throw new Error("Unexpected handler"); };
function executor(handlers: Partial<ToolHandlers> = {}) {
  const defaults: ToolHandlers = {
    get_goal: async (args, ctx) => ({ goal: await ctx.repositories.goals.get(ctx.ownerId, args.goalId) }),
    list_tasks: async () => ({ tasks: [] }), get_progress: () => ({ completed: 0, total: 0, percent: 0 }),
    create_goal_contract_draft: (args, ctx) => {
      const updated = ctx.repositories.goals.update(ownerId, args.goalId, args.expectedGoalVersion, { agentState: "contract_review" });
      const payload = { schemaVersion: 2, assumptions: [], baseGoalVersion: updated.version, contract: args.contract };
      return toolRegistry.create_goal_contract_draft.resultSchema.parse({ draft: ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: args.goalId, kind: "goal_contract", payload, contentHash: contentHash(payload) }) });
    },
    create_plan_draft: unused, diagnose_blocker: args => ({ advice: { taskId: args.taskId, blockerCategory: args.blockerCategory, ...args.advice } }),
    propose_replan: unused, record_check_in: (args, ctx) => {
      const { expectedGoalVersion, ...values } = args;
      if (ctx.repositories.goals.get(ownerId, args.goalId)?.version !== expectedGoalVersion) throw new AppError("VERSION_CONFLICT", 409, "stale");
      return { checkIn: ctx.repositories.support.createCheckIn(ownerId, values) };
    },
    update_task_status: unused, undo_last_change: unused, save_approved_contract: unused,
    save_approved_plan: unused, delete_task: unused, delete_goal: unused, clear_all_data: unused,
  };
  return new ToolExecutor({ repositories, operations: new OperationService(repositories), approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support), undo: new UndoService(repositories), handlers: { ...defaults, ...handlers }, approvalReviewers: {} });
}
function setup(sequence: (ModelTurn | Error | ((request: ModelRequest) => Promise<ModelTurn>))[], handlers: Partial<ToolHandlers> = {}, now?: () => Date) {
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: vi.fn(async request => {
    ModelRequestSchema.parse(request); requests.push(structuredClone(request));
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(request);
    if (!next) throw new Error("Queue exhausted");
    return next;
  }) };
  const tools = executor(handlers);
  const budget = new UsageBudgetService(repositories);
  const orchestrator = new AgentOrchestrator({ repositories, model, tools, budget, now });
  return { orchestrator, model, tools, requests, budget };
}
async function state(agentState: AgentState) { goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState }); }
async function approvedPlan() {
  await state("planning");
  const payload = makePlanPayload(goal, [], planTasks(), ["交付"], null, "agent");
  const artifact = await repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "plan", payload, contentHash: contentHash(payload) });
  const staged = await repositories.plans.createDraft(ownerId, goal.id, { draftArtifactId: artifact.id, expectedDraftArtifactVersion: artifact.version });
  const approved = await repositories.plans.approve(ownerId, staged.id, staged.version);
  await repositories.plans.updateDraftArtifact(ownerId, artifact.id, artifact.version, { status: "approved" });
  goal = (await repositories.goals.get(ownerId, goal.id))!;
  if (goal.agentState !== "active") await state("active");
  return repositories.tasks.listByGoal(ownerId, goal.id, approved.id);
}
async function claim() { return (await repositories.support.getOperationByOperationId(ownerId, `agent-turn:${input.requestOperationId}`))!; }
function checkInArgs() { return { goalId: goal.id, taskId: null, kind: "reflection" as const, blockerCategory: null, note: "继续学习", minutesSpent: null, availableWeeklyMinutes: null, expectedGoalVersion: goal.version }; }
beforeEach(async () => {
  db = createDatabase(":memory:"); migrateDatabase(db); repositories = createRepositories(db);
  goal = await repositories.goals.create(ownerId, contract);
  await repositories.support.createAppSetting(ownerId, settings);
  input = { ownerId, goalId: goal.id, userMessage: "我每天可以学习一小时", explicitIntent: false, requestOperationId: randomUUID() };
});
afterEach(() => db?.$client.close());

it("replaces a no-tool capacity-conflicted replan with trusted concise numbers", async () => {
  const tasks = await approvedPlan();
  await repositories.tasks.update(ownerId, tasks[0].id, tasks[0].version, { status: "done" });
  await repositories.tasks.update(ownerId, tasks[1].id, tasks[1].version, { status: "skipped" });
  input.userMessage = "请根据已记录的卡点和每周时间变化提出计划调整草案。";
  input.explicitIntent = false;
  const leaked = `I'll draft a replan with task ${tasks[2].id}. Let me think through the constraints.`;
  const { orchestrator, model } = setup([turn(leaked)], {}, () => new Date("2027-01-01T00:00:00.000Z"));

  const result = await orchestrator.processTurn(input);

  expect(result.message).toBe("本轮尚未生成重规划草案：当前未完成估时30分钟，剩余估算可用0分钟，按当前估时有30分钟缺口。你希望先调整可用时间，还是通过界面审阅目标范围或期限变更？目标契约不会自动修改，调整后仍需重新核算。");
  expect(result.message).not.toContain(tasks[2].id);
  expect(result).toMatchObject({ state: "active", persistedChange: false, usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 4 } });
  expect(result.draftId).toBeUndefined();
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toEqual([]);
  expect(model.complete).toHaveBeenCalledTimes(1);
});

it("keeps a prior rejected-proposal notice instead of replacing it with the current-capacity notice", async () => {
  const source = await approvedPlan();
  input.userMessage = "请根据反馈调整计划。";
  const reduced = source.map(taskInput).map((task, index) => index === 0
    ? { ...task, action: "改写同一工作", estimateMinutes: 20 } : task);
  const proposal = proposalOf(makePlanPayload(goal, source, reduced, ["交付"], "压低原工作估时", "agent"));
  const { orchestrator } = setup([
    turn("", [call("propose_replan", { goalId: goal.id, payload: proposal })]),
    turn("I saved the shortened plan."),
  ], {}, () => new Date("2027-01-01T00:00:00.000Z"));

  const result = await orchestrator.processTurn(input);

  expect(result.message).toContain("提案未保存");
  expect(result.message).not.toContain("本轮尚未生成重规划草案");
  expect(result).toMatchObject({ persistedChange: false, usage: { modelCalls: 2, toolCalls: 1 } });
});

it("rejects a goal changed during the model call before any capacity notice", async () => {
  await approvedPlan();
  input.userMessage = "请根据反馈调整计划。";
  const { orchestrator } = setup([async () => {
    const current = (await repositories.goals.get(ownerId, goal.id))!;
    await repositories.goals.update(ownerId, goal.id, current.version, { motivation: "并发更新" });
    return turn("I will draft a replan.");
  }], {}, () => new Date("2027-01-01T00:00:00.000Z"));

  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toEqual([]);
});

it.each([
  ["我卡住了，请只分析原因。", true, "2027-01-01T00:00:00.000Z"],
  ["请不要重排计划，只分析原因。", true, "2027-01-01T00:00:00.000Z"],
  ["为什么要重排计划？", true, "2027-01-01T00:00:00.000Z"],
  ["请根据反馈调整计划。", true, "2026-12-01T00:00:00.000Z"],
] as const)("preserves ordinary model replies outside a recognized explicit capacity-conflicted replan: %s", async (message, explicitIntent, instant) => {
  await approvedPlan();
  input.userMessage = message;
  input.explicitIntent = explicitIntent;
  const { orchestrator } = setup([turn("按已有记录讨论下一步。")], {}, () => new Date(instant));
  expect((await orchestrator.processTurn(input)).message).toBe("按已有记录讨论下一步。");
});

it("preserves the no-tool model reply when the remaining-capacity estimate is unavailable", async () => {
  // An active, approved contract requires a deadline; a nullable capacity is
  // reachable during intake and must never trigger an active-plan notice.
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { deadline: null });
  input.userMessage = "请根据反馈调整计划。";
  input.explicitIntent = true;
  const { orchestrator } = setup([turn("容量未知，需要先澄清。")], {}, () => new Date("2027-01-01T00:00:00.000Z"));
  expect((await orchestrator.processTurn(input)).message).toBe("容量未知，需要先澄清。");
});

it("does not use the active-plan capacity notice outside an execution or replan state", async () => {
  await approvedPlan();
  await state("planning");
  input.userMessage = "请根据反馈调整计划。";
  input.explicitIntent = true;
  const { orchestrator } = setup([turn("当前先讨论计划条件。")], {}, () => new Date("2027-01-01T00:00:00.000Z"));
  expect((await orchestrator.processTurn(input)).message).toBe("当前先讨论计划条件。");
});

it("persists one clarifying reply and replays the normalized terminal result before changed state and budget", async () => {
  const { orchestrator, model } = setup([turn()]);
  const result = await orchestrator.processTurn(input);
  expect(result).toMatchObject({ message: "你的完成期限是什么？", state: "clarifying", usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 4 } });
  const current = (await repositories.goals.get(ownerId, goal.id))!;
  expect(current.clarificationCount).toBe(1);
  await repositories.goals.update(ownerId, goal.id, current.version, { agentState: "completed", status: "completed" });
  const setting = (await repositories.support.getSettingsByOwner(ownerId))!;
  await repositories.support.updateAppSetting(ownerId, setting.id, setting.version, { dailyInputTokenLimit: 1 });
  expect(await orchestrator.processTurn({ ...input, userMessage: ` ${input.userMessage} ` })).toEqual(result);
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(2);
  expect(await claim()).toMatchObject({ status: "succeeded" });
});

it("queued function calling: user → model tool request → validated local draft → tool result → final reply", async () => {
  const toolCall = call("create_goal_contract_draft", { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract });
  const queued = new MockModelClient([turn("", [toolCall]), turn("草案已保存，请查看后确认。")]);
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: async request => { requests.push(structuredClone(request)); return queued.complete(request); } };
  const result = await new AgentOrchestrator({ repositories, model, budget: new UsageBudgetService(repositories), tools: executor() }).processTurn(input);
  expect(result).toMatchObject({ state: "contract_review", persistedChange: true, draftId: expect.any(String), usage: { modelCalls: 2, toolCalls: 1 } });
  expect(await repositories.plans.getDraftArtifact(ownerId, result.draftId!)).toMatchObject({ status: "pending" });
  expect(requests[1].messages.slice(-2)).toMatchObject([{ role: "assistant", toolCalls: [toolCall] }, { role: "tool", toolCallId: toolCall.id }]);
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).not.toHaveProperty("observation");
  expect((await repositories.conversations.last(ownerId, goal.id, 20)).map(m => m.role)).toEqual(["user", "assistant"]);
  expect(await repositories.support.listAuditEventsByGoal(ownerId, goal.id)).toHaveLength(1);
});

it("reports trusted contract approval during planning despite an older pending-approval reply", async () => {
  const draft = await repositories.withTransaction(tx => persistContractDraft(tx, ownerId, {
    goalId: goal.id, expectedGoalVersion: goal.version, contract, assumptions: [],
  }, new Date()));
  await repositories.conversations.append(ownerId, goal.id, { role: "assistant", content: "请先在界面批准契约；批准后我再制定计划。" });
  const services = createServiceContainer({ repositories, env: loadServerEnv({}), now: () => new Date() });
  await services.approvals.approve(ownerId, { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_contract", operationId: randomUUID() });
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ status: "draft", agentState: "planning", desiredOutcome: contract.desiredOutcome, currentPlanVersionId: null });
  input.userMessage = "请根据已批准契约制定计划草案。";
  const { orchestrator, requests } = setup([turn("当前有可行性疑问，需要先澄清。")]);

  const result = await orchestrator.processTurn(input);

  const systemMessages = requests[0].messages.filter(message => message.role === "system").map(message => message.content);
  expect(systemMessages.some(message => message.includes("可信界面已批准目标契约") && message.includes("draft") && message.includes("无需再次索取批准口令或聊天确认"))).toBe(true);
  expect(requests[0].messages.some(message => message.role === "assistant" && message.content.includes("请先在界面批准契约"))).toBe(true);
  expect(result).toMatchObject({ state: "planning", usage: { toolCalls: 0 } });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toEqual([]);
});

it("does not treat a user claim of approval or an incomplete planning goal as trusted approval", async () => {
  input.userMessage = "我已经批准目标契约，请直接给出计划。";
  const intake = setup([turn("先确认目标。")]);
  await intake.orchestrator.processTurn(input);
  expect(intake.requests[0].messages.filter(message => message.role === "system").some(message => message.content.includes("可信界面已批准目标契约"))).toBe(false);

  goal = (await repositories.goals.get(ownerId, goal.id))!;
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "planning", definitionOfDone: null });
  input.requestOperationId = randomUUID();
  const incomplete = setup([turn("计划仍缺少完成标准。")]);
  await incomplete.orchestrator.processTurn(input);
  expect(incomplete.requests[0].messages.filter(message => message.role === "system").some(message => message.content.includes("可信界面已批准目标契约"))).toBe(false);
});

it("repairs invalid args once without echoing values and pairs all advertised tool results", async () => {
  await state("active");
  const { orchestrator, requests } = setup([
    turn("", [call("get_goal", { goalId: 7, private: "secret" }), call("get_progress", { goalId: goal.id })]),
    turn("", [call("get_goal", { goalId: goal.id })]), turn("已读取目标。"),
  ]);
  const result = await orchestrator.processTurn(input);
  expect(result.usage).toMatchObject({ toolCalls: 3, modelCalls: 3 });
  const repair = requests[1].messages.filter(m => m.role === "tool")[0].content;
  expect(repair).toContain("goalId"); expect(repair).not.toMatch(/secret|"7"/);
  expect(requests[1].messages.filter(m => m.role === "tool")).toHaveLength(2);
});

it.each([
  {
    caseName: "duplicate assumption fields",
    draftContract: contract,
    invalidAssumptions: [{ field: "weeklyMinutes", reason: "private first reason" }, { field: "weeklyMinutes", reason: "private duplicate reason" }],
    fixedAssumptions: [{ field: "weeklyMinutes", reason: "由每周一小时换算" }],
    expectedIssues: [{ path: "assumptions", field: "weeklyMinutes", rule: "duplicate_assumption_field", expected: "Keep at most one assumption for this field" }],
  },
  {
    caseName: "assumption bound to a null field",
    draftContract: { ...contract, constraints: null },
    invalidAssumptions: [{ field: "constraints", reason: "private null-field reason" }],
    fixedAssumptions: [],
    expectedIssues: [{ path: "assumptions", field: "constraints", rule: "null_contract_field", expected: "Remove assumptions for this null contract field; the server supplies its default and explanation" }],
  },
  {
    caseName: "combined duplicate and null binding",
    draftContract: { ...contract, constraints: null },
    invalidAssumptions: [{ field: "weeklyMinutes", reason: "private first reason" }, { field: "weeklyMinutes", reason: "private duplicate reason" }, { field: "constraints", reason: "private null reason" }],
    fixedAssumptions: [{ field: "weeklyMinutes", reason: "由每周一小时换算" }],
    expectedIssues: [
      { path: "assumptions", field: "weeklyMinutes", rule: "duplicate_assumption_field", expected: "Keep at most one assumption for this field" },
      { path: "assumptions", field: "constraints", rule: "null_contract_field", expected: "Remove assumptions for this null contract field; the server supplies its default and explanation" },
    ],
  },
])("repairs $caseName with one safe rule hint and saves only the corrected draft", async ({ draftContract, invalidAssumptions, fixedAssumptions, expectedIssues }) => {
  const first = call("create_goal_contract_draft", { goalId: goal.id, expectedGoalVersion: goal.version, contract: draftContract, assumptions: invalidAssumptions });
  const second = call("create_goal_contract_draft", { goalId: goal.id, expectedGoalVersion: goal.version, contract: draftContract, assumptions: fixedAssumptions });
  const { orchestrator, requests } = setup([turn("", [first]), turn("", [second]), turn("草案已保存，请确认。")], {
    create_goal_contract_draft: (args, ctx) => {
      const updated = ctx.repositories.goals.update(ownerId, args.goalId, args.expectedGoalVersion, { agentState: "contract_review" });
      const payload = { schemaVersion: 2, baseGoalVersion: updated.version, contract: args.contract, assumptions: args.assumptions };
      return toolRegistry.create_goal_contract_draft.resultSchema.parse({ draft: ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: args.goalId, kind: "goal_contract", payload, contentHash: contentHash(payload) }) });
    },
  });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ state: "contract_review", persistedChange: true, draftId: expect.any(String), usage: { toolCalls: 2, modelCalls: 3 } });
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).toEqual({ errors: expectedIssues });
  expect(requests[1].messages.at(-1)!.content).not.toContain("private");
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toHaveLength(1);
  expect(await repositories.plans.getDraftArtifact(ownerId, result.draftId!)).toMatchObject({ status: "pending", payload: { contract: draftContract, assumptions: fixedAssumptions } });
});

it.each(["create_plan_draft", "propose_replan"] as const)("repairs extra task keys for %s with allowed input fields only", async toolName => {
  const tasks = [1, 2, 3].map(index => ({
    id: `${index}1111111-1111-4111-8111-111111111111`, title: `任务${index}`, action: "完成可见步骤",
    doneCriteria: "提供结果", evidenceType: "user_declaration" as const, estimateMinutes: 30,
    dueAt: null, dependencyIds: [],
  }));
  if (toolName === "propose_replan") {
    const original = makePlanPayload(goal, [], tasks, ["初步完成"], null, "agent");
    const artifact = await repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "plan", payload: original, contentHash: contentHash(original) });
    const staged = await repositories.plans.createDraft(ownerId, goal.id, { draftArtifactId: artifact.id, expectedDraftArtifactVersion: artifact.version });
    await repositories.plans.approve(ownerId, staged.id, staged.version);
    await repositories.plans.updateDraftArtifact(ownerId, artifact.id, artifact.version, { status: "approved" });
    goal = (await repositories.goals.get(ownerId, goal.id))!;
  } else await state("planning");
  const plan = await repositories.plans.getCurrent(ownerId, goal.id);
  const source = plan ? await repositories.tasks.listByGoal(ownerId, goal.id, plan.id) : [];
  const payload = makePlanPayload(goal, source, tasks, ["初步完成"], "调整计划", "agent");
  const malformed = { ...proposalOf(payload), tasks: [{ ...tasks[0], status: "done", "private-extra-key": "private-value" }, ...tasks.slice(1)] };
  const first = call(toolName, { goalId: goal.id, payload: malformed });
  const second = call(toolName, { goalId: goal.id, payload: proposalOf(payload) });
  const save = (kind: "plan" | "replan", args: { goalId: string; payload: PlanRevisionPayload }, ctx: Parameters<ToolHandlers["create_plan_draft"]>[1]) => {
    const draft = ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: args.goalId, kind, payload: args.payload, contentHash: contentHash(args.payload) });
    return { draft };
  };
  const { orchestrator, requests } = setup([turn("", [first]), turn("", [second])], {
    create_plan_draft: (args, ctx) => save("plan", args, ctx) as ReturnType<ToolHandlers["create_plan_draft"]>,
    propose_replan: (args, ctx) => save("replan", args, ctx) as ReturnType<ToolHandlers["propose_replan"]>,
  });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ draftId: expect.any(String), usage: { toolCalls: 2, modelCalls: 2 } });
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).toEqual({ errors: [{
    path: "payload.tasks[]",
    expected: "Only task input fields are allowed: id, title, action, doneCriteria, evidenceType, estimateMinutes, dueAt, dependencyIds",
  }] });
  expect(requests[1].messages.at(-1)!.content).not.toContain("private");
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toHaveLength(1);
  expect(await repositories.plans.getDraftArtifact(ownerId, result.draftId!)).toMatchObject({ payload });
});

it("returns a trusted 960-minute plan receipt without a second model call or later tools", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { weeklyMinutes: 600, agentState: "planning" });
  const tasks = planTasks().map((task, index) => ({ ...task, estimateMinutes: [300, 300, 360][index] }));
  const payload = makePlanPayload(goal, [], tasks, ["可核验交付"], null, "agent");
  const save = call("create_plan_draft", { goalId: goal.id, payload: proposalOf(payload) });
  const later = call("record_check_in", checkInArgs());
  const { orchestrator, model } = setup([turn("计划只有11.5小时，已批准。", [save, later])], {
    create_plan_draft: (args, ctx) => toolRegistry.create_plan_draft.resultSchema.parse({ draft: persistPlanDraft(ctx.repositories,
      ownerId, goal.id, args.payload, "agent") }),
  });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ draftId: expect.any(String), persistedChange: true,
    usage: { modelCalls: 1, toolCalls: 1, inputTokens: 10, outputTokens: 4 } });
  expect(result.message).toContain("960分钟");
  expect(result.message).toContain("待批准");
  expect(result.message).toContain("3项任务");
  expect(result.message).not.toContain("11.5小时");
  expect(result.message).not.toContain("已批准");
  expect(result.message).toContain("未执行后续");
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect(await repositories.support.listCheckInsByGoal(ownerId, goal.id)).toEqual([]);
  expect(await repositories.plans.getDraftArtifact(ownerId, result.draftId!)).toMatchObject({ status: "pending", payload: { tasks } });
});

it("overrides false no-tool text after a capacity rejection with bounded historical facts", async () => {
  await state("planning");
  const tasks = planTasks().map(task => ({ ...task, estimateMinutes: 320 }));
  const payload = makePlanPayload(goal, [], tasks, ["交付"], null, "agent");
  const bad = call("create_plan_draft", { goalId: goal.id, payload: proposalOf(payload) });
  const { orchestrator, requests } = setup([turn("", [bad]), turn("已保存780分钟计划，无需修改目标。")]);

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ state: "planning", persistedChange: false, usage: { modelCalls: 2, toolCalls: 1 } });
  expect(result.message).toContain("提案未保存");
  expect(result.message).toContain("刚才被拒绝提案校验时：未完成估时960分钟，可用");
  expect(result.message).toContain("重新核算");
  expect(result.message).not.toContain("已保存780分钟");
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).toMatchObject({ errors: [{ path: "payload.tasks", rule: "capacity_exceeded" }] });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toEqual([]);
});

it.each([
  ["create_plan_draft", 9], ["propose_replan", 9],
  ["create_plan_draft", 2], ["propose_replan", 2],
] as const)("repairs a %s proposal with %i tasks using the bounded task-count hint", async (toolName, invalidSize) => {
  if (toolName === "create_plan_draft") await state("planning");
  const source = toolName === "propose_replan" ? await approvedPlan() : [];
  const tasks = [...source.map(taskInput), ...Array.from({ length: 9 - source.length }, () => ({
    ...planTasks()[0], id: randomUUID(), title: "独立可核验步骤",
  }))];
  const payload = { base: { goalVersion: goal.version, planVersionId: goal.currentPlanVersionId },
    milestones: ["交付"], changeReason: toolName === "propose_replan" ? "拆成可核验的小步" : null };
  const first = call(toolName, { goalId: goal.id, payload: { ...payload, tasks: tasks.slice(0, invalidSize) } });
  const second = call(toolName, { goalId: goal.id, payload: { ...payload, tasks: tasks.slice(0, 8) } });
  const { orchestrator, requests } = setup([turn("", [first]), turn("", [second])], {
    create_plan_draft: (args, ctx) => toolRegistry.create_plan_draft.resultSchema.parse({ draft:
      persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }),
    propose_replan: (args, ctx) => toolRegistry.propose_replan.resultSchema.parse({ draft:
      persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }),
  });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ draftId: expect.any(String), usage: { modelCalls: 2, toolCalls: 2 } });
  expect(result.message).toContain("共8项任务，总估时240分钟");
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).toEqual({ errors: [{ path: "payload.tasks",
    expected: "3 to 8 tasks total, including retained completed tasks; split a standalone small starter without expanding whole proposal beyond 8" }] });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toHaveLength(1);
});

it.each([
  ["create_plan_draft", "id"], ["create_plan_draft", "dependencyIds"],
  ["propose_replan", "id"], ["propose_replan", "dependencyIds"],
] as const)("repairs %s invalid UUIDv4 %s without echoing model values", async (toolName, field) => {
  if (toolName === "create_plan_draft") await state("planning");
  const source = toolName === "propose_replan" ? await approvedPlan() : [];
  const tasks = source.length ? source.map(taskInput) : planTasks();
  if (toolName === "propose_replan") tasks[1] = { ...tasks[1], action: "改用可核验方法" };
  const invalidValue = "private-invalid-uuid";
  const invalid = tasks.map((task, index) => index === 1 && field === "id" ? { ...task, id: invalidValue }
    : index === 2 && field === "dependencyIds" ? { ...task, dependencyIds: [invalidValue] } : task);
  const payload = { base: { goalVersion: goal.version, planVersionId: goal.currentPlanVersionId },
    milestones: ["交付"], changeReason: toolName === "propose_replan" ? "调整方法" : null };
  const first = call(toolName, { goalId: goal.id, payload: { ...payload, tasks: invalid } });
  const second = call(toolName, { goalId: goal.id, payload: { ...payload, tasks } });
  const { orchestrator, requests } = setup([turn("", [first]), turn("", [second])], {
    create_plan_draft: (args, ctx) => toolRegistry.create_plan_draft.resultSchema.parse({ draft:
      persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }),
    propose_replan: (args, ctx) => toolRegistry.propose_replan.resultSchema.parse({ draft:
      persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }),
  });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ draftId: expect.any(String), usage: { modelCalls: 2, toolCalls: 2 } });
  const feedback = JSON.parse(requests[1].messages.at(-1)!.content);
  expect(feedback.errors).toContainEqual({ path: field === "id" ? "payload.tasks.1.id" : "payload.tasks.2.dependencyIds.0",
    expected: "Use a canonical UUIDv4: 36 hex/hyphen characters in 8-4-4-4-12 groups, version digit 4 and variant digit 8/9/a/b. New task IDs must be unique; dependency IDs must match task IDs in this proposal. Copy existing task IDs exactly from the current snapshot; never regenerate them." });
  expect(JSON.stringify(feedback)).not.toContain(invalidValue);
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toHaveLength(1);
});

it("uses a corrected plan draft after a constraint repair instead of the earlier rejection", async () => {
  await state("planning");
  const bad = makePlanPayload(goal, [], planTasks().map(task => ({ ...task, estimateMinutes: 320 })), ["交付"], null, "agent");
  const good = makePlanPayload(goal, [], planTasks(), ["交付"], null, "agent");
  const { orchestrator, requests } = setup([
    turn("", [call("create_plan_draft", { goalId: goal.id, payload: proposalOf(bad) })]),
    turn("先前不合法的方案已经保存。", [call("create_plan_draft", { goalId: goal.id, payload: proposalOf(good) })]),
  ], { create_plan_draft: (args, ctx) => toolRegistry.create_plan_draft.resultSchema.parse({ draft:
    persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }) });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ draftId: expect.any(String), persistedChange: true, usage: { modelCalls: 2, toolCalls: 2 } });
  expect(result.message).toContain("总估时90分钟");
  expect(result.message).not.toContain("提案未保存");
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).toMatchObject({ errors: [{ rule: "capacity_exceeded" }] });
  expect(await repositories.plans.getDraftArtifact(ownerId, result.draftId!)).toMatchObject({ status: "pending" });
});

it("keeps the one-repair ceiling after a second invalid capacity proposal", async () => {
  await state("planning");
  const invalid = (minutes: number) => call("create_plan_draft", { goalId: goal.id, payload: proposalOf(makePlanPayload(goal, [],
    planTasks().map(task => ({ ...task, estimateMinutes: minutes })), ["交付"], null, "agent")) });
  const { orchestrator, model } = setup([turn("", [invalid(320)]), turn("", [invalid(321)])]);

  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  expect(model.complete).toHaveBeenCalledTimes(2);
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toEqual([]);
});

it("does not report a saved plan after another owner-visible goal change follows the tool", async () => {
  await state("planning");
  const payload = makePlanPayload(goal, [], planTasks(), ["交付"], null, "agent");
  const { orchestrator, tools } = setup([turn("", [call("create_plan_draft", { goalId: goal.id, payload: proposalOf(payload) })])], {
    create_plan_draft: (args, ctx) => toolRegistry.create_plan_draft.resultSchema.parse({ draft:
      persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }),
  });
  const execute = tools.executeObserved.bind(tools);
  vi.spyOn(tools, "executeObserved").mockImplementation(async request => {
    const observed = await execute(request);
    const current = (await repositories.goals.get(ownerId, goal.id))!;
    await repositories.goals.update(ownerId, goal.id, current.version, { title: "并发修改" });
    return observed;
  });

  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toHaveLength(1);
  expect((await repositories.conversations.last(ownerId, goal.id, 20)).map(message => message.role)).toEqual(["user"]);
});

it("does not report a saved plan after a concurrent feedback withdrawal fences its context", async () => {
  await state("planning");
  await repositories.support.createCheckIn(ownerId, { goalId: goal.id, taskId: null, kind: "reflection",
    blockerCategory: null, note: "预置反馈", minutesSpent: null, availableWeeklyMinutes: null });
  goal = (await repositories.goals.get(ownerId, goal.id))!;
  const payload = makePlanPayload(goal, [], planTasks(), ["交付"], null, "agent");
  const { orchestrator, tools } = setup([turn("", [call("create_plan_draft", { goalId: goal.id, payload: proposalOf(payload) })])], {
    create_plan_draft: (args, ctx) => toolRegistry.create_plan_draft.resultSchema.parse({ draft:
      persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }),
  });
  const execute = tools.executeObserved.bind(tools);
  vi.spyOn(tools, "executeObserved").mockImplementation(async request => {
    const observed = await execute(request);
    await repositories.withTransaction(tx => {
      const checkIn = tx.support.listCheckInsByGoal(ownerId, goal.id).at(-1)!;
      const latest = tx.support.getLatestPendingUndo(ownerId, goal.id)!;
      const withdrawnAt = new Date().toISOString();
      tx.support.withdrawCheckIn(ownerId, checkIn.id, checkIn.version, withdrawnAt);
      tx.support.updateUndoRecord(ownerId, latest.id, latest.version, { undoneAt: withdrawnAt,
        conversationFence: { revision: 1, throughMessageId: tx.conversations.last(ownerId, goal.id, 1).at(-1)?.id ?? null,
          throughAgentTurnOperationId: null } });
    });
    return observed;
  });

  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.conversations.getSnapshot(ownerId, goal.id)).toMatchObject({ fenceRevision: 1 });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toHaveLength(1);
});

it("keeps an earlier check-in and its usage when a later replan draft is saved", async () => {
  const source = await approvedPlan();
  input.explicitIntent = true;
  const next = source.map(taskInput);
  next[1] = { ...next[1], action: "改用可核验的新方法" };
  const afterCheckIn = { ...goal, version: goal.version + 1 };
  const payload = makePlanPayload(afterCheckIn, source, next, ["交付"], "调整方法", "agent");
  const { orchestrator, model } = setup([
    turn("", [call("record_check_in", checkInArgs())]),
    turn("总共只有20分钟。", [call("propose_replan", { goalId: goal.id, payload: proposalOf(payload) })]),
  ], { propose_replan: (args, ctx) => toolRegistry.propose_replan.resultSchema.parse({ draft:
    persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }) });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ draftId: expect.any(String), persistedChange: true,
    usage: { modelCalls: 2, toolCalls: 2, inputTokens: 20, outputTokens: 8 } });
  expect(result.message).toContain("调整草案已保存");
  expect(result.message).toContain("总估时90分钟");
  expect(result.message).not.toContain("20分钟");
  expect(await repositories.support.listCheckInsByGoal(ownerId, goal.id)).toHaveLength(1);
  expect(await repositories.plans.getDraftArtifact(ownerId, result.draftId!)).toMatchObject({ status: "pending" });
  expect(await orchestrator.processTurn(input)).toEqual(result);
  expect(model.complete).toHaveBeenCalledTimes(2);
});

it("reports a rejected replan without denying an earlier committed check-in", async () => {
  const source = await approvedPlan();
  input.explicitIntent = true;
  const next = source.map(taskInput).map(task => ({ ...task, estimateMinutes: 320 }));
  const payload = makePlanPayload({ ...goal, version: goal.version + 1 }, source, next, ["交付"], "压低容量", "agent");
  const { orchestrator } = setup([
    turn("", [call("record_check_in", checkInArgs())]),
    turn("", [call("propose_replan", { goalId: goal.id, payload: proposalOf(payload) })]),
    turn("已经没有任何记录，也保存了调整方案。"),
  ]);

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ persistedChange: true, usage: { modelCalls: 3, toolCalls: 2 } });
  expect(result.message).toContain("提案未保存");
  expect(result.message).not.toContain("没有任何记录");
  expect(await repositories.support.listCheckInsByGoal(ownerId, goal.id)).toHaveLength(1);
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toEqual([]);
});

it("reports trusted before/after totals when rewritten replan work is reduced and no tool follows", async () => {
  const source = await approvedPlan();
  const reduced = source.map(taskInput).map((task, index) => index === 0
    ? { ...task, action: "换一种说法执行", estimateMinutes: 20 } : task);
  const payload = makePlanPayload(goal, source, reduced, ["交付"], "字面调整", "agent");
  const { orchestrator, requests } = setup([
    turn("", [call("propose_replan", { goalId: goal.id, payload: proposalOf(payload) })]),
    turn("已保存80分钟方案。"),
  ]);

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ persistedChange: false, usage: { modelCalls: 2, toolCalls: 1 } });
  expect(result.message).toContain("提案未保存");
  expect(result.message).toContain("刚才被拒绝提案校验时：当前未完成估时90分钟，提案未完成估时80分钟");
  expect(result.message).toContain("通过界面审阅手动计划变更");
  expect(result.message).not.toContain("已保存80分钟");
  const feedback = JSON.parse(requests[1].messages.at(-1)!.content);
  expect(feedback).toMatchObject({ errors: [{ path: "payload.tasks", rule: "unfinished_workload_reduced",
    expected: expect.stringContaining("Current unfinished estimate: 90 minutes. Proposed unfinished estimate: 80 minutes.") }] });
  expect(feedback.errors[0].expected).toMatch(/Estimated remaining capacity: \d+ minutes\. Proposed unfinished estimates: 80 minutes\.$/);
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toEqual([]);
});

it("uses one shared repair to keep the prior unfinished total and save a valid replan", async () => {
  const source = await approvedPlan();
  const reduced = source.map(taskInput).map((task, index) => index === 0
    ? { ...task, action: "换一种说法执行", estimateMinutes: 20 } : task);
  const corrected = reduced.map((task, index) => index === 0 ? { ...task, estimateMinutes: 30 } : task);
  const proposal = (tasks: typeof reduced) => ({ goalId: goal.id, payload: proposalOf(makePlanPayload(goal, source,
    tasks, ["交付"], "保留原工作量", "agent")) });
  const { orchestrator, requests } = setup([
    turn("", [call("propose_replan", proposal(reduced))]),
    turn("已通过。", [call("propose_replan", proposal(corrected))]),
  ], { propose_replan: (args, ctx) => toolRegistry.propose_replan.resultSchema.parse({ draft:
    persistPlanDraft(ctx.repositories, ownerId, goal.id, args.payload, "agent") }) });

  const result = await orchestrator.processTurn(input);

  expect(result).toMatchObject({ draftId: expect.any(String), usage: { modelCalls: 2, toolCalls: 2 } });
  expect(result.message).toContain("总估时90分钟");
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).toMatchObject({ errors: [{ rule: "unfinished_workload_reduced" }] });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, goal.id)).toHaveLength(1);
});

it("rejects second invalid arguments without mutating domain rows and caches the safe failure", async () => {
  const { orchestrator, model } = setup([turn("", [call("get_goal", { goalId: 7 })]), turn("", [call("get_goal", { goalId: false })])]);
  const first = await orchestrator.processTurn(input).catch(e => e);
  expect(first).toMatchObject({ code: "MODEL_RESPONSE_INVALID", turn: { persistedChange: false, state: "intake" } });
  const replay = await orchestrator.processTurn(input).catch(e => e);
  expect(replay).toMatchObject({ code: first.code, status: first.status, turn: first.turn });
  expect(model.complete).toHaveBeenCalledTimes(2);
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(1);
  expect(await claim()).toMatchObject({ status: "failed" });
  expect(db.$client.prepare("SELECT status, error_code FROM agent_runs").all()).toEqual([{ status: "failed", error_code: "MODEL_RESPONSE_INVALID" }]);
});

it("stops canonical duplicate tools and rejects a fourth tool request", async () => {
  await state("active");
  const { orchestrator } = setup([turn("", [call("get_goal", { goalId: goal.id })]), turn("", [call("get_goal", { goalId: goal.id })])]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "AGENT_LIMIT_REACHED" });
  input.requestOperationId = randomUUID();
  const four = setup([turn("", [call("get_goal", { goalId: goal.id }), call("list_tasks", { goalId: goal.id }), call("get_progress", { goalId: goal.id }), call("get_goal", { goalId: goal.id })])]);
  await expect(four.orchestrator.processTurn(input)).rejects.toMatchObject({ code: "AGENT_LIMIT_REACHED" });
  expect(db.$client.prepare("SELECT tool_call_count FROM agent_runs ORDER BY rowid DESC LIMIT 1").get()).toEqual({ tool_call_count: 3 });
});

it("counts a timeout retry toward four model attempts and refuses a fifth", async () => {
  await state("active");
  const { orchestrator, model } = setup([timeout(), turn("", [call("get_goal", { goalId: goal.id })]), turn("", [call("list_tasks", { goalId: goal.id })]), turn("", [call("get_progress", { goalId: goal.id })])]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "AGENT_LIMIT_REACHED" });
  expect(model.complete).toHaveBeenCalledTimes(4);
});

it.each([false, true])("retries one pre-mutation timeout using persisted fallback=%s", async fallbackEnabled => {
  const setting = (await repositories.support.getSettingsByOwner(ownerId))!;
  await repositories.support.updateAppSetting(ownerId, setting.id, setting.version, { fallbackEnabled });
  const { orchestrator, requests } = setup([timeout(), turn()]);
  expect((await orchestrator.processTurn(input)).usage.modelCalls).toBe(2);
  expect(requests.map(r => r.model)).toEqual([QWEN_PRIMARY_MODEL, fallbackEnabled ? QWEN_FALLBACK_MODEL : QWEN_PRIMARY_MODEL]);
});

it("stops at the daily budget before provider dispatch", async () => {
  const setting = (await repositories.support.getSettingsByOwner(ownerId))!;
  await repositories.support.updateAppSetting(ownerId, setting.id, setting.version, { dailyInputTokenLimit: 1 });
  const { orchestrator, model } = setup([turn()]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
  expect(model.complete).not.toHaveBeenCalled(); expect(await claim()).toMatchObject({ status: "failed" });
});

it("preserves committed review progress after final timeout and never retries that timeout", async () => {
  const { orchestrator, model } = setup([turn("", [call("create_goal_contract_draft", { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract })]), timeout()]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_TIMEOUT", turn: { state: "contract_review", persistedChange: true } });
  expect((await repositories.goals.get(ownerId, goal.id))!.agentState).toBe("contract_review");
  expect(model.complete).toHaveBeenCalledTimes(2);
});

it.each(["completed", "failed_recoverable"] as const)("rejects a new turn in %s before creating any run or message", async current => {
  await state(current); const { orchestrator, model } = setup([turn()]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect(await claim()).toBeNull(); expect(model.complete).not.toHaveBeenCalled();
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toEqual([]);
});

it("rejects changed input and concurrent same-ID admission while the original call is pending", async () => {
  let release!: (turn: ModelTurn) => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const { orchestrator, model } = setup([async () => { entered(); return new Promise(resolve => { release = resolve; }); }]);
  const first = orchestrator.processTurn(input); await ready;
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  await expect(orchestrator.processTurn({ ...input, userMessage: "不同内容" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  release(turn()); await first;
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(2);
});

it("settles known invalid-response usage before preserving its stable failure", async () => {
  const { orchestrator } = setup([new ModelResponseError({ inputTokens: 31, outputTokens: 9 })]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  expect(db.$client.prepare("SELECT input_token_count, output_token_count FROM agent_runs").get()).toEqual({ input_token_count: 31, output_token_count: 9 });
  expect(db.$client.prepare("SELECT * FROM operations WHERE tool_name='record_model_usage'").all()).toHaveLength(1);
});

it.each(["你的期限是什么？", "请补充你的完成标准。", "每周能安排多少分钟", "可以开始吗"])("caps clarification for question/request: %s", async text => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "clarifying", clarificationCount: 3 });
  const { orchestrator, requests } = setup([turn(text)]);
  const result = await orchestrator.processTurn(input);
  expect(result.message).toBe("已达到三轮澄清上限，当前信息将保留供你查看。");
  expect(result.state).toBe("clarifying");
  expect(requests[0].messages.some(m => m.role === "system" && m.content.includes("不得继续提问"))).toBe(true);
  expect((await repositories.goals.get(ownerId, goal.id))!.clarificationCount).toBe(3);
});

it.each([0, 3])("keeps a declarative reply without increasing clarification count %s", async count => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { clarificationCount: count });
  const { orchestrator } = setup([turn("下一步先阅读一页。")]);
  expect(await orchestrator.processTurn(input)).toMatchObject({ state: "intake", message: "下一步先阅读一页。" });
  expect((await repositories.goals.get(ownerId, goal.id))!.clarificationCount).toBe(count);
});

it("at cap replaces missing critical facts, but preserves committed review progress even with nullable Goal fields", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { clarificationCount: 3, desiredOutcome: null });
  const first = setup([turn("下一步先阅读一页。")]);
  expect(await first.orchestrator.processTurn(input)).toMatchObject({ state: "clarifying", message: "还缺少预期结果或完成标准，当前保留在澄清阶段。" });
  goal = (await repositories.goals.get(ownerId, goal.id))!;
  input.requestOperationId = randomUUID();
  const review = setup([turn("", [call("create_goal_contract_draft", { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract })]), turn("请确认草案。")]);
  expect(await review.orchestrator.processTurn(input)).toMatchObject({ state: "contract_review", message: "请确认草案。", persistedChange: true });
});

it("does not treat noncritical null fields as missing critical facts", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { clarificationCount: 3, deadline: null, weeklyMinutes: null, constraints: null, motivation: null });
  const { orchestrator } = setup([turn("当前信息已保留。")]);
  expect((await orchestrator.processTurn(input)).message).toBe("当前信息已保留。");
});

it.each(["completed", "archived"] as const)("rejects terminal Goal status %s before writes", async status => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { status });
  const { orchestrator, model } = setup([turn()]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect(await claim()).toBeNull(); expect(model.complete).not.toHaveBeenCalled();
});

it("does not implicitly resume a paused goal", async () => {
  goal = await repositories.goals.update(ownerId, goal.id, goal.version, { status: "paused", agentState: "paused" });
  const { orchestrator } = setup([turn("现在开始吗？")]);
  expect(await orchestrator.processTurn(input)).toMatchObject({ state: "paused" });
  expect((await repositories.goals.get(ownerId, goal.id))!.status).toBe("paused");
});

it.each(["paused", "completed"] as const)("preserves concurrent %s when a provider fails", async next => {
  await state("active");
  const { orchestrator } = setup([async () => {
    await repositories.goals.update(ownerId, goal.id, goal.version, { agentState: next, status: next });
    throw new AppError("VERSION_CONFLICT", 409, "original safe failure");
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT", turn: { state: next } });
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ version: goal.version + 1, agentState: next, status: next });
  expect(db.$client.prepare("SELECT status,end_state FROM agent_runs").get()).toEqual({ status: "failed", end_state: next });
});

it("rejects a stale successful reply without overwriting concurrent changes", async () => {
  const { orchestrator } = setup([async () => {
    await repositories.goals.update(ownerId, goal.id, goal.version, { title: "另一个操作" });
    return turn();
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ title: "另一个操作", version: goal.version + 1 });
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(1);
});

async function clearWorkspace() {
  return repositories.withTransaction(tx => {
    const operation = tx.support.createOperation(ownerId, { goalId: null, operationId: randomUUID(), toolName: "clear_all_data", parameterHash: "a".repeat(64) });
    tx.support.clearOwnerData(ownerId, operation.id);
    tx.support.createAppSetting(ownerId, settings);
  });
}

it.each([false, true])("never recreates a deleted goal/run; clear=%s determines global usage retention", async clear => {
  const { orchestrator } = setup([async () => {
    if (clear) await clearWorkspace(); else await repositories.goals.delete(ownerId, goal.id);
    return turn("旧回复不应保存。");
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: clear ? "VERSION_CONFLICT" : "NOT_FOUND", status: clear ? 409 : 404, turn: { state: null } });
  expect(await repositories.goals.get(ownerId, goal.id)).toBeNull();
  expect(await claim()).toBeNull();
  expect(db.$client.prepare("SELECT * FROM agent_runs").all()).toEqual([]);
  expect(db.$client.prepare("SELECT * FROM conversation_messages").all()).toEqual([]);
  expect(db.$client.prepare("SELECT * FROM operations WHERE tool_name='record_model_usage'").all()).toHaveLength(clear ? 0 : 1);
});

it("cancels known invalid-response usage after clear before recording or recovering it", async () => {
  const { orchestrator } = setup([async () => { await clearWorkspace(); throw new ModelResponseError({ inputTokens: 9, outputTokens: 8 }); }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT", turn: { state: null } });
  expect(db.$client.prepare("SELECT * FROM operations WHERE tool_name='record_model_usage'").all()).toEqual([]);
});

it("finishes a committed plan_review directly and replays its trusted receipt", async () => {
  await state("planning");
  const payload = makePlanPayload(goal, [], planTasks(), ["基础", "应用"], null, "agent");
  const { orchestrator, model } = setup([turn("", [call("create_plan_draft", { goalId: goal.id, payload: proposalOf(payload) })]), new AppError("MODEL_RESPONSE_INVALID", 502, "private")], {
    create_plan_draft: (args, ctx) => {
      const changed = ctx.repositories.goals.update(ownerId, goal.id, goal.version, { agentState: "plan_review" });
      const reviewed = { ...args.payload, base: { ...args.payload.base, goalVersion: changed.version } };
      return toolRegistry.create_plan_draft.resultSchema.parse({ draft: ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "plan", payload: reviewed, contentHash: contentHash(reviewed) }) });
    },
  });
  const result = await orchestrator.processTurn(input);
  expect(result).toMatchObject({ state: "plan_review", persistedChange: true, draftId: expect.any(String), usage: { modelCalls: 1 } });
  expect(result.message).toContain("总估时90分钟");
  expect(await orchestrator.processTurn(input)).toEqual(result);
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect((await repositories.goals.get(ownerId, goal.id))!.agentState).toBe("plan_review");
});

it("does not resume a pending turn after a committed check-in with new provider IDs ready", async () => {
  await state("active"); input.explicitIntent = true;
  let signal!: () => void; let finish!: (value: ModelTurn) => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  const { orchestrator, model } = setup([turn("", [call("record_check_in", checkInArgs())]), async () => { signal(); return new Promise(resolve => { finish = resolve; }); }, turn("", [call("record_check_in", checkInArgs())])]);
  const original = orchestrator.processTurn(input); await waiting;
  expect(await repositories.support.listCheckInsByGoal(ownerId, goal.id)).toHaveLength(1);
  const replacement = setup([turn("", [call("record_check_in", checkInArgs())])]);
  await expect(replacement.orchestrator.processTurn(input)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect(replacement.model.complete).not.toHaveBeenCalled();
  finish(turn("已记录。")); const result = await original;
  expect(await replacement.orchestrator.processTurn(input)).toEqual(result);
  expect(model.complete).toHaveBeenCalledTimes(2);
  expect(await repositories.support.listCheckInsByGoal(ownerId, goal.id)).toHaveLength(1);
});

it("breaks recovery ownership on a concurrent write before the tool callback", async () => {
  await state("active"); input.explicitIntent = true;
  const { orchestrator, tools } = setup([turn("", [call("record_check_in", { ...checkInArgs(), expectedGoalVersion: goal.version + 1 })]), new AppError("MODEL_RESPONSE_INVALID", 502, "bad")]);
  const execute = tools.executeObserved.bind(tools);
  vi.spyOn(tools, "executeObserved").mockImplementation(async request => {
    const before = (await repositories.goals.get(ownerId, goal.id))!;
    await repositories.goals.update(ownerId, goal.id, before.version, { title: "并发" });
    return execute(request);
  });
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID", turn: { persistedChange: true } });
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ title: "并发", version: goal.version + 2 });
});

it("preserves a concurrent after-commit change instead of claiming it through a reread", async () => {
  await state("active"); input.explicitIntent = true;
  const { orchestrator, tools } = setup([turn("", [call("record_check_in", checkInArgs())]), new AppError("MODEL_RESPONSE_INVALID", 502, "bad")]);
  const execute = tools.executeObserved.bind(tools);
  vi.spyOn(tools, "executeObserved").mockImplementation(async request => {
    const result = await execute(request);
    const current = (await repositories.goals.get(ownerId, goal.id))!;
    await repositories.goals.update(ownerId, goal.id, current.version, { agentState: "reviewing" });
    return result;
  });
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID", turn: { state: "reviewing", persistedChange: true } });
  expect((await repositories.goals.get(ownerId, goal.id))!.version).toBe(goal.version + 2);
});

it("suppresses timeout retry after per-tool replay without reporting a fresh mutation", async () => {
  await state("active"); input.explicitIntent = true;
  const args = checkInArgs(); const id = randomUUID();
  await executor().execute({ toolName: "record_check_in", args, context: { ownerId, goalId: goal.id, source: "model", explicitIntent: true, operationId: `${input.requestOperationId}:${id}` } });
  const { orchestrator, model } = setup([turn("", [call("record_check_in", args, id)]), timeout(), turn()]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_TIMEOUT", turn: { persistedChange: false } });
  expect(model.complete).toHaveBeenCalledTimes(2);
  expect(await repositories.support.listCheckInsByGoal(ownerId, goal.id)).toHaveLength(1);
});

it.each(["APPROVAL_REQUIRED", "VERSION_CONFLICT", "OWNERSHIP_MISMATCH"] as const)("preserves %s even when recovery writes fail", async code => {
  const { orchestrator } = setup([async () => {
    db.$client.exec("CREATE TRIGGER fail_recovery BEFORE UPDATE ON goals WHEN NEW.agent_state='failed_recoverable' BEGIN SELECT RAISE(ABORT, 'secondary'); END;");
    throw new AppError(code, 403, "original private data");
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code, status: 403 });
  expect(await claim()).toMatchObject({ status: "failed" });
  expect((await repositories.goals.get(ownerId, goal.id))!.version).toBe(goal.version);
});

it("keeps a claim pending when terminal finalization fails, without mistaking a safe error for durable caching", async () => {
  const { orchestrator, model } = setup([async () => {
    db.$client.exec("CREATE TRIGGER fail_finalization BEFORE UPDATE ON operations WHEN OLD.tool_name='agent_turn' BEGIN SELECT RAISE(ABORT, 'failure'); END;");
    throw new AppError("MODEL_TIMEOUT", 504, "original");
  }, timeout()]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_TIMEOUT", status: 504 });
  expect(await claim()).toMatchObject({ status: "pending" });
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect(model.complete).toHaveBeenCalledTimes(2);
});

it("settles nonfatal compaction failure usage through the same attempt boundary", async () => {
  for (let n = 0; n < 12; n++) await repositories.conversations.append(ownerId, goal.id, { role: n % 2 ? "assistant" : "user", content: `合成消息${n}` });
  const { orchestrator, requests } = setup([turn("下一步阅读一页。"), new ModelResponseError({ inputTokens: 20, outputTokens: 6 })]);
  expect(await orchestrator.processTurn(input)).toMatchObject({ usage: { modelCalls: 2, inputTokens: 30, outputTokens: 10 } });
  expect(requests[1].tools).toEqual([]);
  expect(await repositories.conversations.getSummary(ownerId, goal.id)).toBeNull();
  expect(db.$client.prepare("SELECT * FROM operations WHERE tool_name='record_model_usage'").all()).toHaveLength(2);
});

it("cancels clear during compaction without resurrecting visible content or claims", async () => {
  for (let n = 0; n < 12; n++) await repositories.conversations.append(ownerId, goal.id, { role: "user", content: `合成消息${n}` });
  const { orchestrator } = setup([turn("下一步阅读一页。"), async () => { await clearWorkspace(); return turn("旧摘要"); }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT", turn: { state: null } });
  expect(db.$client.prepare("SELECT * FROM conversation_messages").all()).toEqual([]);
  expect(db.$client.prepare("SELECT * FROM conversation_summaries").all()).toEqual([]);
  expect(await claim()).toBeNull();
});

it("permits final text after tool replay without inventing fresh write ownership", async () => {
  await state("active"); input.explicitIntent = true;
  const args = checkInArgs(); const id = randomUUID();
  await executor().execute({ toolName: "record_check_in", args, context: { ownerId, goalId: goal.id, source: "model", explicitIntent: true, operationId: `${input.requestOperationId}:${id}` } });
  const before = (await repositories.goals.get(ownerId, goal.id))!;
  const { orchestrator } = setup([turn("", [call("record_check_in", args, id)]), turn("本次读取已保存结果。")]);
  expect(await orchestrator.processTurn(input)).toMatchObject({ state: "active", persistedChange: false });
  expect((await repositories.goals.get(ownerId, goal.id))!.version).toBe(before.version);
});

it("does not silently turn failed compaction accounting into a successful run", async () => {
  for (let n = 0; n < 12; n++) await repositories.conversations.append(ownerId, goal.id, { role: "user", content: `合成消息${n}` });
  const { orchestrator } = setup([turn("你的完成期限是什么？"), async () => {
    db.$client.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON operations WHEN NEW.tool_name='record_model_usage' BEGIN SELECT RAISE(ABORT, 'failure'); END;");
    throw new ModelResponseError({ inputTokens: 20, outputTokens: 6 });
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "DATABASE_ERROR" });
  expect(await claim()).toMatchObject({ status: "failed" });
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(13);
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ agentState: "intake", clarificationCount: 0 });
});

it("repairs malformed JSON once with only a field path/type description", async () => {
  const broken = { id: randomUUID(), name: "get_goal", argumentsJson: "{secret-value" };
  const { orchestrator, requests } = setup([turn("", [broken]), turn("", [call("get_goal", { goalId: goal.id })]), turn("已读取。")]);
  await orchestrator.processTurn(input);
  expect(requests[1].messages.at(-1)).toEqual({ role: "tool", toolCallId: broken.id, content: JSON.stringify({ errors: [{ path: "", expected: "JSON object" }] }) });
});

it("uses type-only repair descriptors for refined UUID fields", async () => {
  const { orchestrator, requests } = setup([turn("", [call("get_goal", { goalId: "bad-sensitive-id" })]), turn("已保留。")]);
  await orchestrator.processTurn(input);
  expect(JSON.parse(requests[1].messages.at(-1)!.content)).toEqual({ errors: [{ path: "goalId", expected: "string" }] });
});

it.each([null, { inputTokens: 11, outputTokens: 7 }])("settles only known counts when a client breaks its response contract: %s", async known => {
  const bad = { text: 8, toolCalls: [], usage: known, finishReason: "stop" } as unknown as ModelTurn;
  const { orchestrator } = setup([bad]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  expect(db.$client.prepare("SELECT input_token_count,output_token_count FROM agent_runs").get()).toEqual({ input_token_count: known?.inputTokens ?? 0, output_token_count: known?.outputTokens ?? 0 });
});

it("rejects blank replies and repeated provider call IDs before another dispatch", async () => {
  const empty = setup([turn("  ")]);
  await expect(empty.orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  input.requestOperationId = randomUUID();
  const id = randomUUID();
  const duplicate = setup([turn("", [call("get_goal", { goalId: goal.id }, id)]), turn("", [call("get_goal", { goalId: 8 }, id)])]);
  await expect(duplicate.orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  expect(duplicate.model.complete).toHaveBeenCalledTimes(2);
});

it("rejects unknown tools and preserves a protected model request's approval error", async () => {
  const unknown = setup([turn("", [call("unknown_tool", {})])]);
  await expect(unknown.orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  input.requestOperationId = randomUUID();
  const blocked = setup([turn("", [call("delete_goal", { goalId: goal.id, expectedGoalVersion: 1, confirmation: "学习" })])]);
  await expect(blocked.orchestrator.processTurn(input)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
});

it("returns validated advice without marking a domain mutation", async () => {
  await state("active");
  const advice = { minimumNextStep: "打开一页", explanation: "减少开始难度" };
  const { orchestrator } = setup([turn("", [call("diagnose_blocker", { goalId: goal.id, taskId: null, blockerCategory: "cannot_start", note: null, advice })]), turn("先打开一页。")]);
  expect(await orchestrator.processTurn(input)).toMatchObject({ advice: { taskId: null, blockerCategory: "cannot_start", ...advice }, persistedChange: false, usage: { toolCalls: 1 } });
});

it("uses the persisted fallback switch changed during the failing attempt", async () => {
  const { orchestrator, requests } = setup([async () => {
    const saved = (await repositories.support.getSettingsByOwner(ownerId))!;
    await repositories.support.updateAppSetting(ownerId, saved.id, saved.version, { fallbackEnabled: true });
    throw timeout();
  }, turn()]);
  await orchestrator.processTurn(input);
  expect(requests[1].model).toBe(QWEN_FALLBACK_MODEL);
});

it("charges compaction retry against the same four-call ceiling", async () => {
  for (let n = 0; n < 12; n++) await repositories.conversations.append(ownerId, goal.id, { role: "user", content: `合成消息${n}` });
  const { orchestrator } = setup([turn("", [call("get_goal", { goalId: goal.id })]), turn("先阅读一页。"), timeout(), turn("用户计划阅读。")]);
  expect(await orchestrator.processTurn(input)).toMatchObject({ usage: { modelCalls: 4, toolCalls: 1, inputTokens: 30 } });
  expect(await repositories.conversations.getSummary(ownerId, goal.id)).toMatchObject({ content: "用户计划阅读。" });
});

it("skips compaction when four attempts are already used", async () => {
  await state("active");
  for (let n = 0; n < 12; n++) await repositories.conversations.append(ownerId, goal.id, { role: "user", content: `合成消息${n}` });
  const { orchestrator, model } = setup([turn("", [call("get_goal", { goalId: goal.id })]), turn("", [call("get_progress", { goalId: goal.id })]), turn("", [call("list_tasks", { goalId: goal.id })]), turn("先阅读一页。")]);
  expect((await orchestrator.processTurn(input)).usage.modelCalls).toBe(4);
  expect(model.complete).toHaveBeenCalledTimes(4);
  expect(await repositories.conversations.getSummary(ownerId, goal.id)).toBeNull();
});

it.each([false, true])("cancels before provider dispatch when recheck detects erased data, clear=%s", async clear => {
  const { orchestrator, model, budget } = setup([turn()]);
  const recheck = budget.recheckBeforeDispatch.bind(budget);
  vi.spyOn(budget, "recheckBeforeDispatch").mockImplementation(async (admission, request) => {
    if (clear) await clearWorkspace();
    else db.$client.prepare("DELETE FROM agent_runs WHERE id = ?").run(admission.runId);
    return recheck(admission, request);
  });
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: clear ? "VERSION_CONFLICT" : "NOT_FOUND", status: clear ? 409 : 404 });
  expect(model.complete).not.toHaveBeenCalled();
  expect(db.$client.prepare("SELECT * FROM operations WHERE tool_name='record_model_usage'").all()).toEqual([]);
  expect(db.$client.prepare("SELECT * FROM agent_runs").all()).toEqual([]);
});

it("allows a single timeout retry after artifact-only draft storage", async () => {
  const { orchestrator, model } = setup([turn("", [call("create_goal_contract_draft", { goalId: goal.id, expectedGoalVersion: goal.version, assumptions: [], contract })]), timeout(), turn("草案已保存。")], {
    create_goal_contract_draft: (args, ctx) => {
      const payload = { schemaVersion: 2, assumptions: [], baseGoalVersion: goal.version, contract: args.contract };
      return toolRegistry.create_goal_contract_draft.resultSchema.parse({ draft: ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "goal_contract", payload, contentHash: contentHash(payload) }) });
    },
  });
  expect(await orchestrator.processTurn(input)).toMatchObject({ persistedChange: false, state: "intake", draftId: expect.any(String), usage: { modelCalls: 3 } });
  expect(model.complete).toHaveBeenCalledTimes(3);
});

it("returns immediately after PlanVersion materialization without risking another provider timeout", async () => {
  await state("planning");
  const payload = makePlanPayload(goal, [], planTasks(), ["基础", "应用"], null, "agent");
  const { orchestrator, model } = setup([turn("", [call("create_plan_draft", { goalId: goal.id, payload: proposalOf(payload) })]), timeout()], {
    create_plan_draft: (args, ctx) => {
      const draft = ctx.repositories.plans.saveDraftArtifact(ownerId, { goalId: goal.id, kind: "plan", payload: args.payload, contentHash: contentHash(args.payload) });
      ctx.repositories.plans.createDraft(ownerId, goal.id, { draftArtifactId: draft.id, expectedDraftArtifactVersion: draft.version });
      return toolRegistry.create_plan_draft.resultSchema.parse({ draft });
    },
  });
  expect(await orchestrator.processTurn(input)).toMatchObject({ state: "planning", persistedChange: true,
    message: expect.stringContaining("总估时90分钟"), usage: { modelCalls: 1, toolCalls: 1 } });
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect(await repositories.plans.listVersions(ownerId, goal.id)).toHaveLength(1);
});

it("normalizes a secret-bearing unknown failure for first delivery, storage and replay", async () => {
  const { orchestrator, model } = setup([new Error("sensitive-provider-body")]);
  const error = await orchestrator.processTurn(input).catch(e => e);
  expect(error).toMatchObject({ code: "DATABASE_ERROR", status: 500, turn: { state: "intake", persistedChange: false } });
  expect(JSON.stringify(error)).not.toContain("sensitive");
  expect(JSON.stringify(await claim())).not.toContain("sensitive");
  expect(await orchestrator.processTurn(input).catch(e => e)).toMatchObject({ code: error.code, status: error.status, turn: error.turn });
  expect(model.complete).toHaveBeenCalledTimes(1);
});

it("canonicalizes reordered tool arguments before a duplicate can write again", async () => {
  await state("active"); input.explicitIntent = true;
  const args = checkInArgs();
  const { orchestrator, model } = setup([turn("", [call("record_check_in", args)]), turn("", [call("record_check_in", Object.fromEntries(Object.entries(args).reverse()))])]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "AGENT_LIMIT_REACHED", turn: { persistedChange: true } });
  expect(model.complete).toHaveBeenCalledTimes(2);
  expect(await repositories.support.listCheckInsByGoal(ownerId, goal.id)).toHaveLength(1);
});

it("repairs JSON numbers outside finite range instead of bypassing parameter repair", async () => {
  const broken = { id: randomUUID(), name: "get_goal", argumentsJson: '{"goalId":1e400}' };
  const { orchestrator, requests } = setup([turn("", [broken]), turn("已保留。")]);
  expect((await orchestrator.processTurn(input)).usage.toolCalls).toBe(1);
  expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: broken.id });
  expect(requests[1].messages.at(-1)!.content).not.toContain("Infinity");
});

it.each([false, true])("rolls back every final success surface when terminal cache write fails, failure-cache-also-blocked=%s", async blockAllTerminal => {
  const { orchestrator, model } = setup([async () => {
    db.$client.exec(`CREATE TRIGGER fail_success_cache BEFORE UPDATE ON operations WHEN OLD.tool_name='agent_turn' AND ${blockAllTerminal ? "NEW.status IN ('succeeded','failed')" : "NEW.status='succeeded'"} BEGIN SELECT RAISE(ABORT, 'terminal write failure'); END;`);
    return turn("你的完成期限是什么？");
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "DATABASE_ERROR", turn: { state: "intake", persistedChange: false } });
  expect((await repositories.conversations.last(ownerId, goal.id, 20)).map(m => ({ role: m.role, content: m.content }))).toEqual([{ role: "user", content: input.userMessage }]);
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ agentState: "intake", clarificationCount: 0 });
  expect(db.$client.prepare("SELECT status,end_state,input_token_count,output_token_count FROM agent_runs").get()).toEqual({ status: blockAllTerminal ? "running" : "failed", end_state: blockAllTerminal ? null : "intake", input_token_count: 10, output_token_count: 4 });
  expect(await claim()).toMatchObject({ status: blockAllTerminal ? "pending" : "failed" });
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: blockAllTerminal ? "INVALID_TRANSITION" : "DATABASE_ERROR" });
  expect(model.complete).toHaveBeenCalledTimes(1);
});

it("compacts only persisted history while the final reply and clarification remain staged", async () => {
  for (let n = 0; n < 12; n++) await repositories.conversations.append(ownerId, goal.id, { role: "user", content: `旧消息${n}` });
  let during: { messageCount: number; goal: Goal | null; run: unknown; claimStatus: string } | undefined;
  const { orchestrator, requests } = setup([turn("你的完成期限是什么？"), async () => {
    during = { messageCount: (await repositories.conversations.last(ownerId, goal.id, 20)).length,
      goal: await repositories.goals.get(ownerId, goal.id), run: db.$client.prepare("SELECT status FROM agent_runs").get(), claimStatus: (await claim()).status };
    return turn("用户正在整理学习计划。");
  }]);
  expect(await orchestrator.processTurn(input)).toMatchObject({ state: "clarifying", usage: { modelCalls: 2 } });
  expect(during).toMatchObject({ messageCount: 13, goal: { clarificationCount: 0, agentState: "intake" }, run: { status: "running" }, claimStatus: "pending" });
  expect(JSON.parse(requests[1].messages[1].content).messages).toHaveLength(7);
  expect(JSON.stringify(requests[1].messages)).not.toContain("你的完成期限是什么");
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(14);
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ clarificationCount: 1, agentState: "clarifying" });
  expect(await claim()).toMatchObject({ status: "succeeded" });
});

it("rechecks ownership after compaction before any final reply or clarification is committed", async () => {
  for (let n = 0; n < 12; n++) await repositories.conversations.append(ownerId, goal.id, { role: "user", content: `旧消息${n}` });
  const { orchestrator } = setup([turn("你的完成期限是什么？"), async () => {
    const current = (await repositories.goals.get(ownerId, goal.id))!;
    await repositories.goals.update(ownerId, goal.id, current.version, { agentState: "paused", status: "paused" });
    return turn("用户正在整理学习计划。");
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "VERSION_CONFLICT", turn: { state: "paused" } });
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({ agentState: "paused", status: "paused", clarificationCount: 0, version: goal.version + 1 });
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(13);
});

it.each([
  new Error("secondary database failure"),
  new AppError("NOT_FOUND", 404, "unverified read error"),
  new AppError("VERSION_CONFLICT", 409, "unverified read error"),
])("preserves provider timeout when liveness cannot be verified, secondary=%s", async secondary => {
  const { orchestrator, model } = setup([async () => {
    vi.spyOn(repositories, "withTransaction").mockRejectedValueOnce(secondary);
    throw timeout();
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: "MODEL_TIMEOUT", status: 504 });
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect(await claim()).toMatchObject({ status: "failed" });
  expect(db.$client.prepare("SELECT error_code FROM agent_runs").get()).toEqual({ error_code: "MODEL_TIMEOUT" });
});

it.each([false, true])("verified erased data still overrides the provider error, clear=%s", async clear => {
  const { orchestrator, model } = setup([async () => {
    if (clear) await clearWorkspace(); else await repositories.goals.delete(ownerId, goal.id);
    throw timeout();
  }]);
  await expect(orchestrator.processTurn(input)).rejects.toMatchObject({ code: clear ? "VERSION_CONFLICT" : "NOT_FOUND", status: clear ? 409 : 404, turn: { state: null } });
  expect(model.complete).toHaveBeenCalledTimes(1);
  expect(await claim()).toBeNull();
});

it("leaves a staged thirteenth message for a later turn's compaction", async () => {
  for (let n = 0; n < 11; n++) await repositories.conversations.append(ownerId, goal.id, { role: "user", content: `旧消息${n}` });
  const first = setup([turn("你的完成期限是什么？")]);
  expect(await first.orchestrator.processTurn(input)).toMatchObject({ usage: { modelCalls: 1 } });
  expect(await repositories.conversations.getSummary(ownerId, goal.id)).toBeNull();
  expect(await repositories.conversations.last(ownerId, goal.id, 20)).toHaveLength(13);
  input.requestOperationId = randomUUID();
  const next = setup([turn("下一步先阅读一页。"), turn("用户正在安排学习。")]);
  expect(await next.orchestrator.processTurn(input)).toMatchObject({ usage: { modelCalls: 2 } });
  expect(await repositories.conversations.getSummary(ownerId, goal.id)).toMatchObject({ content: "用户正在安排学习。" });
});
