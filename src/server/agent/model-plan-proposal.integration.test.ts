import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { TaskCreateInputSchema } from "../repositories/revision-contracts";
import { loadServerEnv } from "../config/env";
import { LOCAL_OWNER_ID as ownerId } from "../security/local-owner";
import { createServiceContainer } from "../services/service-container";
import { approvedGoal, executionInput } from "../services/service-test-fixtures";
import { createToolHandlers } from "../services/tool-handlers";
import { makePlanPayload } from "../services/draft-preparation";
import { OperationService } from "../operations/operation-service";
import { ApprovalService } from "../security/approval-service";
import { AuditService } from "../audit/audit-service";
import { UndoService } from "../operations/undo-service";
import { ToolExecutor } from "./tool-executor";
import { UsageBudgetService } from "./usage-budget";
import { AgentOrchestrator } from "./orchestrator";
import { modelPlanProposalArgsSchema, materializeModelPlanProposal } from "./model-plan-proposal";
import { assertModelPlanConstraints } from "./model-plan-proposal";
import type { Goal, Task } from "@/core/domain/contracts";
import type { ModelClient, ModelRequest, ModelTurn } from "./model-contracts";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.$client.close()));

it("bounds unfinished proposed work, excluding retained done/skipped but counting reset skipped tasks", () => {
  const goal = { deadline: "2026-09-28", weeklyMinutes: 180 } as Goal;
  const now = "2026-09-21T23:59:59.999+08:00";
  const input = (id: string, estimateMinutes: number, dependencyIds: string[] = []) => ({
    id, title: id, action: id, doneCriteria: id, evidenceType: "text" as const,
    estimateMinutes, dueAt: null, dependencyIds,
  });
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const base = [input(a, 60), input(b, 60), input(c, 150, [b])];
  const source = base.map((task, index) => ({ ...task, status: index === 0 ? "done" : index === 1 ? "skipped" : "todo" })) as Task[];
  expect(() => assertModelPlanConstraints(goal, source, base, [], now)).not.toThrow();
  expect(() => assertModelPlanConstraints(goal, source, base.map((task, index) => index === 2 ? { ...task, estimateMinutes: 180 } : task), [], now)).not.toThrow();
  expect(() => assertModelPlanConstraints(goal, source, base.map((task, index) => index === 2 ? { ...task, estimateMinutes: 181 } : task), [], now))
    .toThrowError(expect.objectContaining({ rule: "capacity_exceeded" }));
  expect(() => assertModelPlanConstraints(goal, source, base.map((task, index) => index === 1 ? { ...task, action: "changed" } : task), [], now))
    .toThrowError(expect.objectContaining({ rule: "capacity_exceeded" }));
  const skippedDependent = source.map((task, index) => index === 2 ? { ...task, status: "skipped" as const } : task);
  const changedPrerequisite = base.map((task, index) => index === 1 ? { ...task, action: "changed" } : task);
  expect(() => assertModelPlanConstraints(goal, skippedDependent, changedPrerequisite, [], now))
    .toThrowError(expect.objectContaining({ rule: "capacity_exceeded" }));
  expect(() => assertModelPlanConstraints(goal, source, base, [], "2026-09-29T00:00:00+08:00"))
    .toThrowError(expect.objectContaining({ rule: "capacity_exceeded" }));
  expect(() => assertModelPlanConstraints(goal, source.map(task => ({ ...task, status: "done" as const })), base, [], "2026-09-29T00:00:00+08:00"))
    .not.toThrow();
});

it("applies the same capacity ceiling to an initial model plan without a source plan", () => {
  const goal = { deadline: "2026-09-28", weeklyMinutes: 180 } as Goal;
  const tasks = [60, 60, 60].map(estimateMinutes => ({ id: randomUUID(), title: "任务", action: "执行",
    doneCriteria: "可核验", evidenceType: "text" as const, estimateMinutes, dueAt: null, dependencyIds: [] }));
  const now = "2026-09-21T23:59:59.999+08:00";
  expect(() => assertModelPlanConstraints(goal, [], tasks, [], now)).not.toThrow();
  expect(() => assertModelPlanConstraints(goal, [], tasks.map((task, index) => index === 2
    ? { ...task, estimateMinutes: 61 } : task), [], now))
    .toThrowError(expect.objectContaining({ rule: "capacity_exceeded", capacity: {
      estimatedRemainingMinutes: 180, proposedUnfinishedMinutes: 181 } }));
});

it("rejects unchanged-work estimate reductions at both model boundaries while retaining stale priority and manual freedom", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  const workspace = await approvedGoal(services);
  const proposed = workspace.tasks.map((task, index) => ({ ...TaskCreateInputSchema.strip().parse(task),
    ...(index === 0 ? { estimateMinutes: task.estimateMinutes - 15 } : {}) }));
  const raw = { goalId: workspace.goal.id, payload: { base: { goalVersion: workspace.goal.version,
    planVersionId: workspace.currentPlan!.id }, milestones: workspace.currentPlan!.milestones,
    changeReason: "每周时间变少", tasks: proposed } };
  await expect(materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id, repositories,
    now: new Date(), proposal: modelPlanProposalArgsSchema.parse({ ...raw, payload: { ...raw.payload,
      base: { ...raw.payload.base, goalVersion: raw.payload.base.goalVersion - 1 } } }) }))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id, repositories,
    now: new Date(), proposal: modelPlanProposalArgsSchema.parse(raw) }))
    .rejects.toMatchObject({ rule: "unchanged_work_estimate_reduced" });
  const replacementId = randomUUID();
  await expect(materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id, repositories,
    now: new Date(), proposal: modelPlanProposalArgsSchema.parse({ ...raw,
      payload: { ...raw.payload, tasks: proposed.map((task, index) => ({ ...task,
        ...(index === 0 ? { id: replacementId } : {}),
        dependencyIds: task.dependencyIds.map(id => id === proposed[0].id ? replacementId : id) })) } }) }))
    .rejects.toMatchObject({ rule: "unchanged_work_estimate_reduced" });
  const payload = makePlanPayload(workspace.goal, workspace.tasks, proposed, workspace.currentPlan!.milestones,
    "每周时间变少", "agent");
  const tools = new ToolExecutor({ repositories, operations: new OperationService(repositories),
    approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support),
    undo: new UndoService(repositories), handlers: createToolHandlers(env, () => new Date()), approvalReviewers: {} });
  await expect(tools.executeObserved({ toolName: "propose_replan", args: { goalId: workspace.goal.id, payload },
    context: { ownerId, goalId: workspace.goal.id, source: "model", explicitIntent: false,
      operationId: randomUUID() } })).rejects.toMatchObject({ rule: "unchanged_work_estimate_reduced" });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
  const manual = await services.plans.createManualDraft(ownerId, { goalId: workspace.goal.id,
    expectedGoalVersion: workspace.goal.version, expectedPlanVersion: { id: workspace.currentPlan!.id,
      version: workspace.currentPlan!.version }, changeReason: "用户自行审阅估时", tasks: proposed,
    operationId: randomUUID() });
  expect(manual.status).toBe("pending");
});

it("rechecks the source estimate inside the executor transaction after adapter materialization", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  const workspace = await approvedGoal(services);
  const proposed = workspace.tasks.map((task, index) => ({ ...TaskCreateInputSchema.strip().parse(task),
    ...(index === 0 ? { title: `${task.title}（按主题排序）` } : {}) }));
  const proposal = modelPlanProposalArgsSchema.parse({ goalId: workspace.goal.id, payload: {
    base: { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id },
    milestones: workspace.currentPlan!.milestones, changeReason: "调整呈现顺序", tasks: proposed } });
  const materialized = await materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id,
    repositories, now: new Date(), proposal });
  // Simulate a concurrent task-row estimate update that did not advance Goal.version.
  db.$client.prepare("UPDATE tasks SET estimate_minutes = estimate_minutes + 30, version = version + 1 WHERE id = ?")
    .run(workspace.tasks[0].id);
  const tools = new ToolExecutor({ repositories, operations: new OperationService(repositories),
    approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support),
    undo: new UndoService(repositories), handlers: createToolHandlers(env, () => new Date()), approvalReviewers: {} });
  await expect(tools.executeObserved({ toolName: "propose_replan", args: materialized,
    context: { ownerId, goalId: workspace.goal.id, source: "model", explicitIntent: false,
      operationId: randomUUID() } })).rejects.toMatchObject({ rule: "unchanged_work_estimate_reduced" });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
});

it("prioritizes stale base and rechecks the trusted unfinished floor inside the executor transaction", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  const workspace = await approvedGoal(services);
  const tasks = workspace.tasks.map((task, index) => ({ ...TaskCreateInputSchema.strip().parse(task),
    ...(index === 0 ? { action: `${task.action}调整方法` } : {}) }));
  const raw = { goalId: workspace.goal.id, payload: { base: { goalVersion: workspace.goal.version,
    planVersionId: workspace.currentPlan!.id }, milestones: workspace.currentPlan!.milestones,
    changeReason: "改进方法但保留总工作量", tasks } };
  await expect(materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id, repositories,
    now: new Date(), proposal: modelPlanProposalArgsSchema.parse({ ...raw, payload: { ...raw.payload,
      base: { ...raw.payload.base, goalVersion: raw.payload.base.goalVersion - 1 },
      tasks: tasks.map((task, index) => index === 0 ? { ...task, estimateMinutes: 40 } : task) } }) }))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const materialized = await materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id,
    repositories, now: new Date(), proposal: modelPlanProposalArgsSchema.parse(raw) });
  // Legacy concurrent task-row estimate update does not bump Goal.version.
  db.$client.prepare("UPDATE tasks SET estimate_minutes = estimate_minutes + 30, version = version + 1 WHERE id = ?")
    .run(workspace.tasks[0].id);
  const tools = new ToolExecutor({ repositories, operations: new OperationService(repositories),
    approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support),
    undo: new UndoService(repositories), handlers: createToolHandlers(env, () => new Date()), approvalReviewers: {} });
  await expect(tools.executeObserved({ toolName: "propose_replan", args: materialized,
    context: { ownerId, goalId: workspace.goal.id, source: "model", explicitIntent: false,
      operationId: randomUUID() } })).rejects.toMatchObject({ rule: "unfinished_workload_reduced", workload: {
    currentUnfinishedMinutes: 210, proposedUnfinishedMinutes: 180 } });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
});

it("uses exactly one existing repair for an unchanged-work underestimate before saving a corrected real draft", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  const workspace = await approvedGoal(services);
  const tasks = workspace.tasks.map(task => TaskCreateInputSchema.strip().parse(task));
  const invalid = tasks.map((task, index) => index === 0 ? { ...task, estimateMinutes: 40 } : task);
  const corrected = tasks.map((task, index) => index === 0 ? { ...task, action: `${task.action}先用一个合成样例验证`, estimateMinutes: 40 }
    : index === 1 ? { ...task, estimateMinutes: 80, action: `${task.action}整合样例并完成原范围` } : task);
  const turn = (values: typeof tasks): ModelTurn => ({ text: "", toolCalls: [{ id: randomUUID(), name: "propose_replan",
    argumentsJson: JSON.stringify({ goalId: workspace.goal.id, payload: { base: { goalVersion: workspace.goal.version,
      planVersionId: workspace.currentPlan!.id }, milestones: workspace.currentPlan!.milestones,
      changeReason: "先缩小一项练习范围", tasks: values } }) }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls" });
  const queue = [turn(invalid), turn(corrected)];
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: async request => { requests.push(structuredClone(request)); return queue.shift()!; } };
  const injected = createServiceContainer({ repositories, env, mockClientFactory: () => model });
  const result = await injected.agent.processTurn(ownerId, { goalId: workspace.goal.id, message: "请核对估时",
    requestOperationId: randomUUID() });
  expect(result).toMatchObject({ draftId: expect.any(String), usage: { toolCalls: 2, modelCalls: 2 } });
  expect(result.message).toContain("调整草案已保存，待批准；共3项任务，总估时180分钟");
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool",
    content: expect.stringContaining("unchanged action and doneCriteria") });
  expect(requests[1].messages.at(-1)!.content).not.toContain(tasks[0].id);
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toHaveLength(1);
});

it("materializes canonical replan metadata through the real executor while keeping execution pending until approval", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  let workspace = await approvedGoal(services);
  await services.tasks.update(ownerId, workspace.tasks[0].id, { ...executionInput(workspace), status: "done",
    evidence: { type: "text", text: "完成并核验" } }, "ui_explicit");
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  const before = workspace;
  const tasks = workspace.tasks.map((task, index) => ({ ...TaskCreateInputSchema.strip().parse(task),
    ...(index === 1 ? { action: `${task.action}缩小未完成任务起步范围` } : {}) }));
  const proposal = modelPlanProposalArgsSchema.parse({ goalId: workspace.goal.id,
    payload: { base: { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id },
      milestones: workspace.currentPlan!.milestones, changeReason: "重新核验首项任务", tasks } });
  const materialized = await materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id, proposal, repositories, now: new Date() });
  expect(materialized.payload.executionResets).toEqual([
    { taskKey: tasks[1].id, reason: "completion_meaning_changed" },
    { taskKey: tasks[2].id, reason: "prerequisite_reset" },
  ]);
  expect(materialized.payload.changeSource).toBe("agent");
  expect(materialized.payload.diff.changed).toContain(tasks[1].id);
  const first: ModelTurn = { text: "", toolCalls: [{ id: randomUUID(), name: "propose_replan",
    argumentsJson: JSON.stringify(proposal) }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls" };
  const queue = [first];
  const model: ModelClient = { complete: async () => queue.shift()! };
  const tools = new ToolExecutor({ repositories, operations: new OperationService(repositories),
    approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support),
    undo: new UndoService(repositories), handlers: createToolHandlers(env, () => new Date()), approvalReviewers: {} });
  const result = await new AgentOrchestrator({ repositories, model, tools, budget: new UsageBudgetService(repositories) })
    .processTurn({ ownerId, goalId: workspace.goal.id, userMessage: "请重排", requestOperationId: randomUUID(), explicitIntent: false });
  expect(result).toMatchObject({ state: "plan_review", draftId: expect.any(String), usage: { modelCalls: 1, toolCalls: 1 } });
  expect(result.message).toContain("调整草案已保存，待批准；共3项任务，总估时180分钟");
  const draft = await repositories.plans.getDraftArtifact(ownerId, result.draftId!);
  expect(draft).toMatchObject({ kind: "replan", status: "pending", payload: { executionResets: materialized.payload.executionResets,
    diff: materialized.payload.diff, changeSource: "agent" } });
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  expect(workspace.currentPlan!.id).toBe(before.currentPlan!.id);
  expect(workspace.tasks[0].status).toBe("done");
  expect(workspace.evidence).toEqual(before.evidence);
  await services.approvals.approve(ownerId, { goalId: workspace.goal.id, draftId: draft!.id,
    expectedDraftVersion: draft!.version, toolName: "save_approved_plan", operationId: randomUUID() });
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  expect(workspace.currentPlan!.id).not.toBe(before.currentPlan!.id);
  expect(workspace.tasks[0].status).toBe("done");
  expect(workspace.tasks[0].actualMinutes).toBe(before.tasks[0].actualMinutes);
  expect(workspace.evidence).toHaveLength(1);
  expect(await repositories.support.listEvidenceByTask(ownerId, before.tasks[0].id)).toHaveLength(1);
});

it("rejects stale caller bases and foreign goal scope before materializing a revision", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const services = createServiceContainer({ repositories, env: loadServerEnv({}) });
  const workspace = await approvedGoal(services);
  const tasks = workspace.tasks.map(task => TaskCreateInputSchema.strip().parse(task));
  const base = { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id };
  const raw = { goalId: workspace.goal.id, payload: { base, milestones: workspace.currentPlan!.milestones,
    changeReason: "重新审查", tasks } };
  const parse = (value: unknown) => modelPlanProposalArgsSchema.parse(value);
  await expect(materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id, repositories, now: new Date(),
    proposal: parse({ ...raw, goalId: randomUUID() }) })).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
  for (const stale of [{ ...base, goalVersion: base.goalVersion - 1 }, { ...base, planVersionId: randomUUID() }])
    await expect(materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id, repositories, now: new Date(),
      proposal: parse({ ...raw, payload: { ...raw.payload, base: stale } }) })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const unchanged = await materializeModelPlanProposal({ ownerId, turnGoalId: workspace.goal.id,
    repositories, now: new Date(), proposal: parse(raw) });
  const tools = new ToolExecutor({ repositories, operations: new OperationService(repositories),
    approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support),
    undo: new UndoService(repositories), handlers: createToolHandlers(loadServerEnv({}), () => new Date()), approvalReviewers: {} });
  await expect(tools.executeObserved({ toolName: "propose_replan", args: unchanged,
    context: { ownerId, goalId: workspace.goal.id, source: "model", explicitIntent: false,
      operationId: randomUUID() } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
  expect((await repositories.goals.get(ownerId, workspace.goal.id))!.version).toBe(workspace.goal.version);
});

it("rejects model replan of completed meaning or a deadline extension before a pending draft exists", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const services = createServiceContainer({ repositories, env: loadServerEnv({}) });
  let workspace = await approvedGoal(services);
  await services.tasks.update(ownerId, workspace.tasks[0].id, { ...executionInput(workspace), status: "done",
    evidence: { type: "text", text: "已验证" } }, "ui_explicit");
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  const tasks = workspace.tasks.map(task => TaskCreateInputSchema.strip().parse(task));
  const base = { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id };
  const proposal = (nextTasks: typeof tasks) => modelPlanProposalArgsSchema.parse({ goalId: workspace.goal.id,
    payload: { base, milestones: workspace.currentPlan!.milestones, changeReason: "调整未完成部分", tasks: nextTasks } });
  const context = { ownerId, turnGoalId: workspace.goal.id, repositories, now: new Date() };
  await expect(materializeModelPlanProposal({ ...context, proposal: proposal(tasks.map((task, index) =>
    index === 0 ? { ...task, action: `${task.action}改写` } : task)) })).rejects.toMatchObject({ rule: "completed_task_reset" });
  await expect(materializeModelPlanProposal({ ...context, proposal: modelPlanProposalArgsSchema.parse({
    goalId: workspace.goal.id, payload: { base: { ...base, goalVersion: base.goalVersion - 1 },
      milestones: workspace.currentPlan!.milestones, changeReason: "调整", tasks: tasks.map((task, index) =>
        index === 0 ? { ...task, action: `${task.action}改写` } : task) } }) })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const late = new Date(Date.parse(`${workspace.goal.deadline}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await expect(materializeModelPlanProposal({ ...context, proposal: proposal(tasks.map((task, index) =>
    index === 1 ? { ...task, dueAt: late } : task)) })).rejects.toMatchObject({ rule: "deadline_exceeded" });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
});

it.each(["completed_task_reset", "deadline_exceeded", "combined"] as const)("repairs %s once and saves only the corrected real-service draft", async rule => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  let workspace = await approvedGoal(services);
  await services.tasks.update(ownerId, workspace.tasks[0].id, { ...executionInput(workspace), status: "done",
    evidence: { type: "text", text: "已验证" } }, "ui_explicit");
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  const tasks = workspace.tasks.map(task => TaskCreateInputSchema.strip().parse(task));
  const late = new Date(Date.parse(`${workspace.goal.deadline}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const invalidTasks = tasks.map((task, index) => (rule === "completed_task_reset" || rule === "combined") && index === 0
    ? { ...task, action: `${task.action}改写` }
    : (rule === "deadline_exceeded" || rule === "combined") && index === 1 ? { ...task, dueAt: late } : task);
  const correctedTasks = tasks.map((task, index) => index === 1 ? { ...task, action: `${task.action}缩小范围` } : task);
  const proposal = (values: typeof tasks) => ({ goalId: workspace.goal.id, payload: {
    base: { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id },
    milestones: workspace.currentPlan!.milestones, changeReason: "缩小未完成任务", tasks: values } });
  const toolTurn = (values: typeof tasks): ModelTurn => ({ text: "", toolCalls: [{ id: randomUUID(), name: "propose_replan",
    argumentsJson: JSON.stringify(proposal(values)) }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls" });
  const queue = [toolTurn(invalidTasks), toolTurn(correctedTasks)];
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: async request => { requests.push(structuredClone(request)); return queue.shift()!; } };
  const injected = createServiceContainer({ repositories, env, mockClientFactory: () => model });
  const result = await injected.agent.processTurn(ownerId, { goalId: workspace.goal.id, message: "请重排未完成任务",
    requestOperationId: randomUUID() });
  expect(result).toMatchObject({ draftId: expect.any(String), usage: { toolCalls: 2, modelCalls: 2 } });
  expect(result.message).toContain("调整草案已保存，待批准；共3项任务，总估时180分钟");
  expect(requests).toHaveLength(2);
  const feedback = requests[1].messages.at(-1)!;
  expect(feedback.role).toBe("tool");
  expect(feedback.content).toContain("Retain every completed source task ID");
  expect(feedback.content).toContain("on or before the approved goal deadline");
  expect(feedback.content).not.toContain(tasks[0].id);
  const drafts = await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].id).toBe(result.draftId);
  expect(drafts[0].payload).toMatchObject({ executionResets: [
    { taskKey: tasks[1].id, reason: "completion_meaning_changed" },
    { taskKey: tasks[2].id, reason: "prerequisite_reset" },
  ] });
});

it("uses the shared one-repair budget when capacity is still exceeded after a completed-task correction", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  let workspace = await approvedGoal(services);
  await services.tasks.update(ownerId, workspace.tasks[0].id, { ...executionInput(workspace), status: "done",
    evidence: { type: "text", text: "已验证" } }, "ui_explicit");
  await repositories.support.createCheckIn(ownerId, { goalId: workspace.goal.id, taskId: null,
    kind: "availability_change", blockerCategory: null, note: null, minutesSpent: null, availableWeeklyMinutes: 5 });
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  const tasks = workspace.tasks.map(task => TaskCreateInputSchema.strip().parse(task));
  const args = (values: typeof tasks) => ({ goalId: workspace.goal.id, payload: {
    base: { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id },
    milestones: workspace.currentPlan!.milestones, changeReason: "调整", tasks: values } });
  const toolTurn = (values: typeof tasks): ModelTurn => ({ text: "", toolCalls: [{ id: randomUUID(), name: "propose_replan",
    argumentsJson: JSON.stringify(args(values)) }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls" });
  const queue = [toolTurn(tasks.map((task, index) => index === 0 ? { ...task, action: `${task.action}改写` } : task)),
    toolTurn(tasks.map((task, index) => index === 1 ? { ...task, action: `${task.action}缩小范围` } : task))];
  let calls = 0;
  const model: ModelClient = { complete: async () => { calls++; return queue.shift()!; } };
  const injected = createServiceContainer({ repositories, env, mockClientFactory: () => model });
  await expect(injected.agent.processTurn(ownerId, { goalId: workspace.goal.id, message: "请重排未完成任务",
    requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  expect(calls).toBe(2);
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
});

it("refuses a second draft when the apparent capacity fix would erase trusted unfinished workload", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  let workspace = await approvedGoal(services);
  await services.tasks.update(ownerId, workspace.tasks[0].id, { ...executionInput(workspace), status: "done",
    evidence: { type: "text", text: "已验证" } }, "ui_explicit");
  await repositories.support.createCheckIn(ownerId, { goalId: workspace.goal.id, taskId: null,
    kind: "availability_change", blockerCategory: null, note: "每周只剩十五分钟", minutesSpent: null, availableWeeklyMinutes: 15 });
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  const tasks = workspace.tasks.map(task => TaskCreateInputSchema.strip().parse(task));
  const late = new Date(Date.parse(`${workspace.goal.deadline}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const invalid = tasks.map((task, index) => index === 0 ? { ...task, action: `${task.action}改写` }
    : index === 1 ? { ...task, dueAt: late } : task);
  const corrected = tasks.map((task, index) => index === 0 ? task : { ...task,
    estimateMinutes: 20, action: index === 1 ? `${task.action}仅处理一个合成样例并复用组件`
      : `${task.action}用已完成的组件和固定检查表核对` });
  const proposal = (values: typeof tasks) => ({ goalId: workspace.goal.id, payload: {
    base: { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id },
    milestones: workspace.currentPlan!.milestones, changeReason: "把未完成部分限定为一个合成样例并复用现有组件和检查表", tasks: values } });
  const toolTurn = (values: typeof tasks): ModelTurn => ({ text: "", toolCalls: [{ id: randomUUID(), name: "propose_replan",
    argumentsJson: JSON.stringify(proposal(values)) }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls" });
  const queue = [toolTurn(invalid), toolTurn(corrected)];
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: async request => { requests.push(structuredClone(request)); return queue.shift()!; } };
  const injected = createServiceContainer({ repositories, env, mockClientFactory: () => model });
  await expect(injected.agent.processTurn(ownerId, { goalId: workspace.goal.id, message: "按新时间重排",
    requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  expect(requests).toHaveLength(2);
  const feedback = requests[1].messages.at(-1)!.content;
  expect(feedback).toContain("Retain every completed source task ID");
  expect(feedback).toContain("approved goal deadline");
  expect(feedback).toMatch(/Estimated remaining capacity: \d+ minutes\. Proposed unfinished estimates: 180 minutes/);
  expect(feedback).not.toContain(tasks[0].id);
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
});

it("rechecks model capacity in the executor transaction while leaving manual draft semantics unchanged", async () => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  let workspace = await approvedGoal(services);
  await repositories.support.createCheckIn(ownerId, { goalId: workspace.goal.id, taskId: null,
    kind: "availability_change", blockerCategory: null, note: null, minutesSpent: null, availableWeeklyMinutes: 5 });
  workspace = await services.goals.getWorkspace(ownerId, workspace.goal.id);
  const proposed = workspace.tasks.map((task, index) => ({ ...TaskCreateInputSchema.strip().parse(task),
    ...(index === 0 ? { action: `${task.action}仅检验一个示例` } : {}) }));
  const payload = makePlanPayload(workspace.goal, workspace.tasks, proposed, workspace.currentPlan!.milestones, "缩小起步", "agent");
  const tools = new ToolExecutor({ repositories, operations: new OperationService(repositories),
    approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support),
    undo: new UndoService(repositories), handlers: createToolHandlers(env, () => new Date()), approvalReviewers: {} });
  const execute = (nextPayload: typeof payload) => tools.executeObserved({ toolName: "propose_replan",
    args: { goalId: workspace.goal.id, payload: nextPayload }, context: { ownerId, goalId: workspace.goal.id,
      source: "model", explicitIntent: false, operationId: randomUUID() } });
  await expect(execute({ ...payload, base: { ...payload.base, goalVersion: payload.base.goalVersion - 1 } }))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(execute(payload)).rejects.toMatchObject({ rule: "capacity_exceeded" });
  expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
  const manual = await services.plans.createManualDraft(ownerId, { goalId: workspace.goal.id,
    expectedGoalVersion: workspace.goal.version, expectedPlanVersion: { id: workspace.currentPlan!.id,
      version: workspace.currentPlan!.version }, changeReason: "用户手动审阅超额方案", tasks: proposed,
    operationId: randomUUID() });
  expect(manual.status).toBe("pending");
});

it.each(["task_completion", "stale_goal"] as const)("rechecks %s inside the executor transaction before saving", async race => {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv({});
  const services = createServiceContainer({ repositories, env });
  const workspace = await approvedGoal(services);
  const tasks = workspace.tasks.map(task => TaskCreateInputSchema.strip().parse(task));
  const proposal = (values: typeof tasks) => ({ goalId: workspace.goal.id, payload: {
    base: { goalVersion: workspace.goal.version, planVersionId: workspace.currentPlan!.id },
    milestones: workspace.currentPlan!.milestones, changeReason: "缩小未完成任务", tasks: values } });
  const changedCompleted = tasks.map((task, index) => index === 0 ? { ...task, action: `${task.action}改写` } : task);
  const corrected = tasks.map((task, index) => index === 1 ? { ...task, action: `${task.action}缩小范围` } : task);
  const turn = (values: typeof tasks): ModelTurn => ({ text: "", toolCalls: [{ id: randomUUID(), name: "propose_replan",
    argumentsJson: JSON.stringify(proposal(values)) }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls" });
  const queue = [turn(changedCompleted), turn(corrected)];
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: async request => { requests.push(structuredClone(request)); return queue.shift()!; } };
  const executor = new ToolExecutor({ repositories, operations: new OperationService(repositories),
    approvals: new ApprovalService(repositories.support), audit: new AuditService(repositories.support),
    undo: new UndoService(repositories), handlers: createToolHandlers(env, () => new Date()), approvalReviewers: {} });
  let injected = false;
  const tools = { executeObserved: (async (input: Parameters<ToolExecutor["executeObserved"]>[0]) => {
    if (!injected) {
      injected = true;
      if (race === "task_completion") {
        // Simulate a legacy/concurrent task-row change with no Goal version bump.
        db.$client.prepare("UPDATE tasks SET status = 'done', version = version + 1 WHERE id = ?").run(workspace.tasks[0].id);
      } else {
        await repositories.goals.update(ownerId, workspace.goal.id, workspace.goal.version, { title: "并发目标更新" });
      }
    }
    return executor.executeObserved(input);
  }) as ToolExecutor["executeObserved"] };
  const run = new AgentOrchestrator({ repositories, model, tools, budget: new UsageBudgetService(repositories) })
    .processTurn({ ownerId, goalId: workspace.goal.id, userMessage: "请重排", requestOperationId: randomUUID(), explicitIntent: false });
  if (race === "stale_goal") {
    await expect(run).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(requests).toHaveLength(1);
    expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toEqual([]);
  } else {
    const result = await run.catch(error => error);
    expect(result, JSON.stringify({ result, requests: requests.length })).toHaveProperty("draftId");
    expect(result).toMatchObject({ draftId: expect.any(String), usage: { toolCalls: 2, modelCalls: 2 } });
    expect(result.message).toContain("调整草案已保存，待批准；共3项任务，总估时180分钟");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("Retain every completed source task ID") });
    expect(await repositories.support.listPendingDraftArtifacts(ownerId, workspace.goal.id)).toHaveLength(1);
  }
});
