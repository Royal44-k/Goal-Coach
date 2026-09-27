import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { loadServerEnv } from "../config/env";
import { LOCAL_OWNER_ID as owner } from "../security/local-owner";
import { contentHash } from "../security/canonical-json";
import { createServiceContainer } from "./service-container";
import { approvedGoal, executionInput } from "./service-test-fixtures";
import { makePlanPayload, persistPlanDraft } from "./draft-preparation";
import { TaskCreateInputSchema } from "../repositories/revision-contracts";
import { GOAL_REVIEW_REQUEST_MESSAGE } from "@/lib/public-api-schemas";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.$client.close()));
function setup() {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const services = createServiceContainer({ repositories, env: loadServerEnv({}) });
  return { repositories, services };
}
type Services = ReturnType<typeof setup>["services"];
async function finish(services: Services, goalId: string, count = 3) {
  let w = await services.goals.getWorkspace(owner, goalId);
  for (let i = 0; i < count; i++) {
    await services.tasks.update(owner, w.tasks[i].id, { ...executionInput(w, i), status: "done", evidence: { type: "text", text: "已验证" } }, "ui_explicit");
    w = await services.goals.getWorkspace(owner, goalId);
  }
  return w;
}
function reflect(services: Services, goalId: string) {
  return services.agent.processTurn(owner, { goalId, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() });
}

it("restores all-done review after missing configuration, reload and explicit retry, with exact replay", async () => {
  const { repositories, services } = setup();
  let w = await approvedGoal(services); w = await finish(services, w.goal.id);
  let setting = await services.settings.get(owner);
  const selected = await services.settings.update(owner, { expectedVersion: setting.version, provider: "qwen" });
  await services.settings.update(owner, { expectedVersion: selected.version, privacyAccepted: true, privacyProvider: "qwen", privacyPolicyVersion: "2026-09-24" });
  await expect(reflect(services, w.goal.id)).rejects.toMatchObject({ code: "MODEL_CONFIG_MISSING", turn: { state: "reviewing" } });
  const reloaded = createServiceContainer({ repositories, env: loadServerEnv({}) });
  w = await reloaded.goals.getWorkspace(owner, w.goal.id);
  expect(w.goal.agentState).toBe("reviewing"); expect(w.reviewReflection).toBeNull();
  setting = await services.settings.get(owner);
  await services.settings.update(owner, { expectedVersion: setting.version, provider: "mock" });
  const input = { goalId: w.goal.id, message: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true, requestOperationId: randomUUID() };
  const result = await reloaded.agent.processTurn(owner, input);
  expect(result.state).toBe("reviewing");
  expect(await reloaded.agent.processTurn(owner, input)).toEqual(result);
  w = await reloaded.goals.getWorkspace(owner, w.goal.id);
  const complete = { status: "completed", expectedVersion: w.goal.version, operationId: randomUUID() };
  const completed = await reloaded.goals.changeStatus(owner, w.goal.id, complete);
  expect(completed.agentState).toBe("completed");
  expect(await reloaded.goals.changeStatus(owner, w.goal.id, complete)).toEqual(completed);
});

it.each(["active", "paused"] as const)("failure preserves %s incomplete execution", async state => {
  const { services } = setup(); let w = await approvedGoal(services);
  if (state === "paused") await services.goals.changeStatus(owner, w.goal.id, { status: "paused", expectedVersion: w.goal.version, operationId: randomUUID() });
  const setting = await services.settings.get(owner);
  const selected = await services.settings.update(owner, { expectedVersion: setting.version, provider: "qwen" });
  await services.settings.update(owner, { expectedVersion: selected.version, privacyAccepted: true, privacyProvider: "qwen", privacyPolicyVersion: "2026-09-24" });
  await expect(reflect(services, w.goal.id)).rejects.toMatchObject({ code: "MODEL_CONFIG_MISSING" });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.goal.agentState).toBe(state);
});

it("repairs an owned successful retry from legacy active all-done state without a GET write", async () => {
  const { services, repositories } = setup(); let w = await approvedGoal(services); w = await finish(services, w.goal.id);
  const stranded = await repositories.goals.update(owner, w.goal.id, w.goal.version, { agentState: "active" });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).goal).toEqual(stranded);
  expect((await reflect(services, w.goal.id)).state).toBe("reviewing");
  expect((await services.goals.getWorkspace(owner, w.goal.id)).goal.agentState).toBe("reviewing");
});

it("empty current plans cannot complete even with a historical saved reflection", async () => {
  const { services } = setup(); let w = await approvedGoal(services);
  await reflect(services, w.goal.id);
  for (let index = 2; index >= 0; index--) {
    w = await services.goals.getWorkspace(owner, w.goal.id);
    const task = w.tasks[index];
    await services.tasks.remove(owner, task.id, { goalId: w.goal.id, source: "ui_confirmation", confirmationPhrase: task.title, expectedTaskVersion: task.version, expectedGoalVersion: w.goal.version, operationId: randomUUID() });
  }
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.tasks).toEqual([]); expect(w.goal.agentState).toBe("active");
  await expect(services.goals.changeStatus(owner, w.goal.id, { status: "completed", expectedVersion: w.goal.version, operationId: randomUUID() })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
});

it("deleting the last unfinished leaf enters review and deletion replay cannot mutate again", async () => {
  const { services } = setup(); let w = await approvedGoal(services); w = await finish(services, w.goal.id, 2);
  const leaf = w.tasks[2];
  const input = { goalId: w.goal.id, source: "ui_confirmation", confirmationPhrase: leaf.title, expectedTaskVersion: leaf.version, expectedGoalVersion: w.goal.version, operationId: randomUUID() };
  await services.tasks.remove(owner, leaf.id, input);
  const after = await services.goals.getWorkspace(owner, w.goal.id);
  expect(after.goal.agentState).toBe("reviewing"); expect(after.tasks.map(t => t.status)).toEqual(["done", "done"]);
  expect(after.evidence).toHaveLength(2);
  await services.tasks.remove(owner, leaf.id, input);
  expect(await services.goals.getWorkspace(owner, w.goal.id)).toEqual(after);
});

it.each(["approve", "reject", "reset", "paused"] as const)("reconciles retained execution after %s proposal", async action => {
  const { repositories, services } = setup(); let w = await approvedGoal(services);
  w = await finish(services, w.goal.id);
  if (action === "paused") {
    await repositories.goals.update(owner, w.goal.id, w.goal.version, { status: "paused", agentState: "paused" });
    w = await services.goals.getWorkspace(owner, w.goal.id);
  }
  const tasks = w.tasks.map((t, i) => ({ ...TaskCreateInputSchema.strip().parse(t), ...(i === 2 ? action === "reset" ? { doneCriteria: "新的完成定义" } : { title: "重新命名任务" } : {}) }));
  const payload = makePlanPayload(w.goal, w.tasks, tasks, w.currentPlan!.milestones, "重新审查", "agent");
  const draft = await repositories.withTransaction(tx => persistPlanDraft(tx, owner, w.goal.id, payload, action === "paused" ? "user" : "agent"));
  w = await services.goals.getWorkspace(owner, w.goal.id);
  if (action === "reject") {
    const input = { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: w.goal.version, operationId: randomUUID() };
    const result = await services.plans.rejectReplan(owner, input);
    expect(result.goal).toEqual((await services.goals.getWorkspace(owner, w.goal.id)).goal);
    expect(result.goal.agentState).toBe("reviewing");
    expect(await services.plans.rejectReplan(owner, input)).toEqual(result);
  } else {
    const input = { goalId: w.goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan" as const, operationId: randomUUID() };
    const result = await services.approvals.approve(owner, input);
    expect(await services.approvals.approve(owner, input)).toEqual(result);
    w = await services.goals.getWorkspace(owner, w.goal.id);
    expect(w.goal.agentState).toBe(action === "paused" ? "paused" : action === "reset" ? "active" : "reviewing");
    if (action === "paused") {
      const resumed = await services.goals.changeStatus(owner, w.goal.id, { status: "active", expectedVersion: w.goal.version, operationId: randomUUID() });
      expect(resumed.agentState).toBe("reviewing"); expect(resumed).toEqual((await services.goals.getWorkspace(owner, w.goal.id)).goal);
    }
  }
});

it.each(["none", "pending", "failed", "malformed", "unrelated", "foreign-goal", "foreign-owner"])("refuses terminal completion with %s reflection", async kind => {
  const { repositories, services } = setup(); let w = await approvedGoal(services); w = await finish(services, w.goal.id);
  if (kind !== "none") {
    const recordOwner = kind === "foreign-owner" ? randomUUID() : owner;
    const other = kind === "foreign-goal" || kind === "foreign-owner"
      ? await repositories.goals.create(recordOwner, { title: "其他目标", category: "learning", desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null }) : w.goal;
    const operation = await repositories.support.createOperation(recordOwner, { goalId: other.id, operationId: `agent-turn:${randomUUID()}`, toolName: "agent_turn", parameterHash: contentHash({ goalId: other.id, userMessage: kind === "unrelated" ? "随便聊聊" : GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true }) });
    if (kind !== "pending") await repositories.support.updateOperation(recordOwner, operation.id, operation.version, { status: kind === "failed" ? "failed" : "succeeded", result: kind === "malformed" ? { message: "无关记录" } : { schemaVersion: 1, kind: "agent_turn", phase: "done", outcome: { ok: true, data: { message: "复盘", state: "reviewing", persistedChange: false, usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 } } } } });
  }
  await expect(services.goals.changeStatus(owner, w.goal.id, { status: "completed", expectedVersion: w.goal.version, operationId: randomUUID() })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect((await services.goals.getWorkspace(owner, w.goal.id)).goal.status).toBe("active");
});

it("allows historical correlated reflection after undo and recompletion but rejects mixed skips", async () => {
  const { services } = setup(); let w = await approvedGoal(services);
  const reflection = await reflect(services, w.goal.id);
  w = await finish(services, w.goal.id);
  await services.tasks.undo(owner, w.goal.id, { operationId: randomUUID() });
  w = await services.goals.getWorkspace(owner, w.goal.id);
  await services.tasks.update(owner, w.tasks[2].id, { ...executionInput(w, 2), status: "skipped" }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.progress.percent).toBe(100); expect(w.goal.agentState).toBe("active");
  await expect(services.goals.changeStatus(owner, w.goal.id, { status: "completed", expectedVersion: w.goal.version, operationId: randomUUID() })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  await services.tasks.update(owner, w.tasks[2].id, { ...executionInput(w, 2), status: "done", evidence: { type: "text", text: "重新验证" } }, "ui_explicit");
  w = await services.goals.getWorkspace(owner, w.goal.id);
  expect(w.reviewReflection?.message).toBe(reflection.message);
  expect((await services.goals.changeStatus(owner, w.goal.id, { status: "completed", expectedVersion: w.goal.version, operationId: randomUUID() })).status).toBe("completed");
});
