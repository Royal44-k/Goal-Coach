import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { loadServerEnv } from "../config/env";
import { LOCAL_OWNER_ID as owner } from "../security/local-owner";
import { createServiceContainer } from "./service-container";
import { approvedGoal, executionInput } from "./service-test-fixtures";
import { buildAgentContext } from "../agent/context-builder";
import { compactConversationIfNeeded } from "../agent/conversation-compactor";
import { TaskCreateInputSchema } from "../repositories/revision-contracts";
import { GOAL_REVIEW_REQUEST_MESSAGE } from "@/lib/public-api-schemas";
import { toolContracts } from "../agent/tool-contracts";
import { AppError } from "@/core/errors/app-error";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.$client.close()); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-04T16:01:00Z"));
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const services = createServiceContainer({ repositories, env: loadServerEnv({}) });
  return { db, repositories, services };
}
const feedback = { taskId: null, kind: "blocker", blockerCategory: "missing_resource", note: "撤回的独特阻碍", minutesSpent: null, availableWeeklyMinutes: null };

it("keeps original advice freshness and exact replay bytes after withdrawal", async () => {
  const { services, repositories, db } = setup();
  let w = await approvedGoal(services);
  await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  let calls = 0;
  const withModel = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => ({ complete: async () => {
    calls++;
    return { text: "先打开资料。", toolCalls: calls === 1 ? [{ id: "advice", name: "diagnose_blocker", argumentsJson: JSON.stringify({ goalId: w.goal.id, taskId: null, blockerCategory: "missing_resource", note: null, advice: { minimumNextStep: "先打开资料", explanation: "降低起步难度" } }) }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: calls === 1 ? "tool_calls" : "stop" };
  } }) });
  const request = { goalId: w.goal.id, message: "帮我分析", explicitIntent: true, requestOperationId: randomUUID() };
  const result = await withModel.agent.processTurn(owner, request);
  expect(result).toMatchObject({ adviceGoalVersion: w.goal.version, advice: { minimumNextStep: "先打开资料" } });
  const stored = () => db.$client.prepare("SELECT result, parameter_hash FROM operations WHERE operation_id = ?").get(`agent-turn:${request.requestOperationId}`);
  const before = stored();
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID(), expectedUndoId: w.undoCandidate!.id, expectedGoalVersion: w.goal.version });
  expect(await withModel.agent.processTurn(owner, request)).toEqual(result);
  expect(stored()).toEqual(before);
  expect(calls).toBe(2);
  expect((await services.goals.getWorkspace(owner, w.goal.id)).goal.version).toBeGreaterThan(w.goal.version);
});

it.each(["tool", "timeout"] as const)("rejects cached context after concurrent withdrawal during %s without another dispatch", async mode => {
  const { services, repositories, db } = setup();
  let w = await approvedGoal(services);
  await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const sent: string[] = [];
  const withModel = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => ({ complete: async request => {
    sent.push(JSON.stringify(request));
    if (sent.length === 1) {
      await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID(), expectedUndoId: w.undoCandidate!.id, expectedGoalVersion: w.goal.version });
      if (mode === "timeout") throw new AppError("MODEL_TIMEOUT", 504, "offline timeout");
      return { text: "", toolCalls: [{ id: "stale-read", name: "get_goal", argumentsJson: JSON.stringify({ goalId: w.goal.id }) }], usage: { inputTokens: 11, outputTokens: 3 }, finishReason: "tool_calls" };
    }
    return { text: "旧建议", toolCalls: [], usage: { inputTokens: 11, outputTokens: 3 }, finishReason: "stop" };
  } }) });
  const requestOperationId = randomUUID();
  const outcome = await withModel.agent.processTurn(owner, { goalId: w.goal.id, message: "帮我看看", explicitIntent: true, requestOperationId }).catch(error => error);
  expect(sent[0]).toContain(feedback.note);
  expect(sent).toHaveLength(1);
  expect(outcome).toMatchObject({ code: "VERSION_CONFLICT", turn: { persistedChange: false } });
  expect(await repositories.support.getOperationByOperationId(owner, `agent-turn:${requestOperationId}`)).toMatchObject({ status: "failed" });
  expect(db.$client.prepare("SELECT status,input_token_count,output_token_count,tool_call_count FROM agent_runs ORDER BY rowid DESC LIMIT 1").get()).toEqual({ status: "failed", input_token_count: mode === "tool" ? 11 : 0, output_token_count: mode === "tool" ? 3 : 0, tool_call_count: 0 });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).effectiveCheckIns).toEqual([]);
});

it("withdraws latest feedback before task changes, replays exactly, and preserves plan and exported history", async () => {
  const { services } = setup();
  let w = await approvedGoal(services);
  const planId = w.currentPlan!.id;
  const preference = await services.settings.getPreferences(owner);
  await services.settings.updatePreferences(owner, { expectedVersion: preference.version, preferredTimeWindow: "周六上午", effectiveStrategies: ["先读案例"] });
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), status: "doing", actualMinutes: 10 }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const checkIn = await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, taskId: w.tasks[0].id, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.undoCandidate).toMatchObject({ kind: "check_in" });
  expect(w.canUndo).toBe(true);
  const request = { operationId: randomUUID(), expectedUndoId: w.undoCandidate!.id, expectedGoalVersion: w.goal.version };
  const result = await services.tasks.undo(owner, w.goal.id, request);
  expect(result).toMatchObject({ checkIn: { id: checkIn.id, withdrawnAt: expect.any(String) } });
  expect(await services.tasks.undo(owner, w.goal.id, request)).toEqual(result);
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.currentPlan!.id).toBe(planId);
  expect(w.tasks[0]).toMatchObject({ status: "doing", actualMinutes: 10 });
  expect(w.replanTriggers).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "unresolved_blocker" })]));
  expect(w.preference).toMatchObject({ preferredTimeWindow: "周六上午", effectiveStrategies: ["先读案例"], commonBlockers: [] });
  expect(w.undoCandidate).toMatchObject({ kind: "task_execution" });
  expect((await services.data.export(owner)).checkIns).toEqual([expect.objectContaining({ id: checkIn.id, note: feedback.note, withdrawnAt: expect.any(String) })]);
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID(), expectedUndoId: w.undoCandidate!.id, expectedGoalVersion: w.goal.version });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks[0]).toMatchObject({ status: "todo", actualMinutes: null });
  expect(w.canUndo).toBe(false);
});

it("withdraws feedback tied to a historical task, without reverting an approved successor plan", async () => {
  const { services } = setup();
  let w = await approvedGoal(services);
  const oldTask = w.tasks[0];
  const checkIn = await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, taskId: oldTask.id, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  const draft = await services.plans.createManualDraft(owner, { goalId: w.goal.id, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, changeReason: "更新当前行动", operationId: randomUUID(), tasks: w.tasks.map(task => ({ ...TaskCreateInputSchema.strip().parse(task), action: `${task.action}，记录结果` })) });
  await services.approvals.approve(owner, { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() });
  const before = await services.goals.getWorkspace(owner, w.goal.id);
  expect(before.tasks[0].id).not.toBe(oldTask.id);
  expect(await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() })).toMatchObject({ checkIn: { id: checkIn.id, taskId: oldTask.id, withdrawnAt: expect.any(String) } });
  const after = await services.goals.getWorkspace(owner, w.goal.id);
  expect(after.currentPlan).toEqual(before.currentPlan);
  expect(after.tasks).toEqual(before.tasks);
});

it("advances fence revisions in withdrawal order, even without prior messages and with a reversed clock", async () => {
  const { services, repositories, db } = setup();
  let w = await approvedGoal(services);
  db.$client.exec("DELETE FROM conversation_summaries; DELETE FROM conversation_messages");
  for (let i = 0; i < 2; i++) {
    await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
    w = await services.goals.getWorkspace(owner, w.goal.id);
  }
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  expect(await repositories.conversations.getSnapshot(owner, w.goal.id)).toMatchObject({ fenceRevision: 1, unsummarizedMessages: [] });
  await repositories.conversations.append(owner, w.goal.id, { role: "user", content: "首次撤回后的消息" });
  expect((await buildAgentContext({ ownerId: owner, goalId: w.goal.id, repositories })).recentMessages).toEqual([{ role: "user", content: "首次撤回后的消息" }]);
  vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  expect(await repositories.conversations.getSnapshot(owner, w.goal.id)).toMatchObject({ fenceRevision: 2, unsummarizedMessages: [] });
  const ledger = await repositories.support.listUndoRecordsByGoal(owner, w.goal.id);
  expect(ledger.map(row => row.conversationFence?.revision)).toEqual([2, 1]);
  await repositories.conversations.append(owner, w.goal.id, { role: "user", content: "第二次撤回后的消息" });
  expect((await buildAgentContext({ ownerId: owner, goalId: w.goal.id, repositories })).recentMessages).toEqual([{ role: "user", content: "第二次撤回后的消息" }]);
});

it("marks a saved reflection historical after withdrawal and accepts a later explicit replacement", async () => {
  const { services, repositories } = setup();
  let w = await approvedGoal(services);
  await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  const reflection = await services.agent.processTurn(owner, { goalId: w.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.reviewReflection).toMatchObject({ message: reflection.message, stale: false });
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.reviewReflection).toMatchObject({ message: reflection.message, stale: true });
  await repositories.conversations.append(owner, w.goal.id, { role: "assistant", content: reflection.message });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).reviewReflection?.stale).toBe(true);
  await services.agent.processTurn(owner, { goalId: w.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).reviewReflection?.stale).toBe(false);
});

it("keeps legacy undo hashes unbound, rejects half bindings and forbids server-managed creation fields", () => {
  const goalId = randomUUID();
  expect(toolContracts.undo_last_change.args.parse({ goalId })).toEqual({ goalId });
  expect(toolContracts.undo_last_change.args.safeParse({ goalId, expectedUndoId: randomUUID() }).success).toBe(false);
  expect(toolContracts.undo_last_change.args.safeParse({ goalId, expectedGoalVersion: 1 }).success).toBe(false);
  expect(toolContracts.record_check_in.args.safeParse({ ...feedback, goalId, expectedGoalVersion: 1, withdrawnAt: null }).success).toBe(false);
});

it("finishes a model-requested feedback undo without sending withdrawn text back to the model", async () => {
  const { services, repositories } = setup();
  let w = await approvedGoal(services);
  await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  let modelCalls = 0;
  const withModel = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => ({ complete: async () => {
    if (++modelCalls > 1) throw new Error("A successful undo must not send stale context to another model call");
    return { text: "", toolCalls: [{ id: "undo-feedback", name: "undo_last_change", argumentsJson: JSON.stringify({ goalId: w.goal.id, expectedUndoId: w.undoCandidate!.id, expectedGoalVersion: w.goal.version }) }, { id: "must-not-write", name: "record_check_in", argumentsJson: JSON.stringify({ ...feedback, goalId: w.goal.id, expectedGoalVersion: w.goal.version + 1 }) }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
  } }) });
  const outcome = await withModel.agent.processTurn(owner, { goalId: w.goal.id, message: "撤销刚才的反馈", explicitIntent: true, requestOperationId: randomUUID() });
  expect(outcome).toMatchObject({ persistedChange: true, usage: { modelCalls: 1 } });
  expect(outcome.message).toContain("反馈");
  expect(outcome.message).not.toContain(feedback.note);
  expect(outcome.usage.toolCalls).toBe(1);
  expect(outcome.advice).toBeUndefined();
  expect((await services.goals.getWorkspace(owner, w.goal.id)).checkIns[0].withdrawnAt).not.toBeNull();
  expect((await services.goals.getWorkspace(owner, w.goal.id)).checkIns).toHaveLength(1);
});

it("protects owner and goal boundaries and rolls back check-in creation if ledger insertion fails", async () => {
  const { services, repositories, db } = setup();
  const w = await approvedGoal(services), other = await approvedGoal(services);
  const checkIn = await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  await expect(repositories.support.withdrawCheckIn(randomUUID(), checkIn.id, checkIn.version, new Date().toISOString())).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(repositories.support.createUndoRecord(owner, { goalId: other.goal.id, kind: "check_in", checkInId: checkIn.id, taskId: null, forwardPatch: {}, reversePatch: {} })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const before = await services.goals.getWorkspace(owner, w.goal.id);
  db.$client.exec("CREATE TRIGGER reject_ledger BEFORE INSERT ON undo_records BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END");
  await expect(services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: before.goal.version, operationId: randomUUID() })).rejects.toBeDefined();
  expect(await services.goals.getWorkspace(owner, w.goal.id)).toEqual(before);
});

it("rejects a forged conversation boundary and atomically restores the feedback on failure", async () => {
  const { services, repositories } = setup();
  const w = await approvedGoal(services), other = await approvedGoal(services);
  const checkIn = await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  const message = await repositories.conversations.append(owner, other.goal.id, { role: "user", content: "另一个目标" });
  const latest = await repositories.support.getLatestPendingUndo(owner, w.goal.id);
  await expect(repositories.withTransaction(tx => {
    tx.support.withdrawCheckIn(owner, checkIn.id, checkIn.version, new Date().toISOString());
    tx.support.updateUndoRecord(owner, latest!.id, latest!.version, { undoneAt: new Date().toISOString(), conversationFence: { revision: 1, throughMessageId: message.id, throughAgentTurnOperationId: null } });
  })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.support.getCheckIn(owner, checkIn.id)).toEqual(checkIn);
  expect(await repositories.support.getUndoRecord(owner, latest!.id)).toEqual(latest);
});

it("rejects stale bound undo without modifying either entity and rolls back a failed ledger mark", async () => {
  const { services, db } = setup();
  let w = await approvedGoal(services);
  await services.tasks.update(owner, w.tasks[0].id, { ...executionInput(w), status: "doing" }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.undoCandidate).toBeDefined();
  const stale = { operationId: randomUUID(), expectedUndoId: w.undoCandidate!.id, expectedGoalVersion: w.goal.version };
  await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  const before = await services.goals.getWorkspace(owner, w.goal.id);
  await expect(services.tasks.undo(owner, w.goal.id, stale)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await services.goals.getWorkspace(owner, w.goal.id)).toEqual(before);
  db.$client.exec("CREATE TRIGGER reject_undo BEFORE UPDATE ON undo_records BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await expect(services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() })).rejects.toBeDefined();
  expect(await services.goals.getWorkspace(owner, w.goal.id)).toEqual(before);
});

it("fences old messages and summary, rejects in-flight compaction, and compacts only subsequent messages", async () => {
  const { services, repositories } = setup();
  let w = await approvedGoal(services);
  await services.tasks.recordCheckIn(owner, w.goal.id, { ...feedback, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  const first = await repositories.conversations.append(owner, w.goal.id, { role: "user", content: feedback.note });
  await repositories.conversations.replaceSummary(owner, w.goal.id, { throughMessageId: first.id, content: "旧摘要含撤回的独特阻碍" });
  for (let i = 0; i < 14; i++) await repositories.conversations.append(owner, w.goal.id, { role: "user", content: `${feedback.note}${i}` });
  let release!: (value: { text: string; toolCalls: []; usage: { inputTokens: number; outputTokens: number }; finishReason: "stop" }) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = compactConversationIfNeeded({ ownerId: owner, goalId: w.goal.id, model: "mock", repositories, callModel: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  await ready;
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.undoCandidate).toMatchObject({ kind: "check_in" });
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  release({ text: "不应写入的旧摘要", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" });
  expect(await pending).toMatchObject({ status: "skipped", reason: "stale_snapshot" });
  const context = await buildAgentContext({ ownerId: owner, goalId: w.goal.id, repositories });
  expect(JSON.stringify(context)).not.toContain(feedback.note);
  for (let i = 0; i < 14; i++) await repositories.conversations.append(owner, w.goal.id, { role: "user", content: `新反馈${i}` });
  const compacted = await compactConversationIfNeeded({ ownerId: owner, goalId: w.goal.id, model: "mock", repositories, callModel: async request => {
    expect(JSON.stringify(request)).not.toContain(feedback.note);
    expect(JSON.stringify(request)).toContain("新反馈");
    return { text: "新摘要", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
  } });
  expect(compacted.status).toBe("compacted");
  const after = await buildAgentContext({ ownerId: owner, goalId: w.goal.id, repositories });
  expect(after.conversationSummary?.content).toBe("新摘要");
  expect(after.recentMessages).toHaveLength(6);
  expect((await services.data.export(owner)).conversationSummaries).toEqual(expect.arrayContaining([expect.objectContaining({ content: "旧摘要含撤回的独特阻碍" })]));
});
