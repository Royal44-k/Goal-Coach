import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/core/errors/app-error";
import { JsonObjectSchema } from "@/core/domain/contracts";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { AgentTurnStore, type AdmittedTurn, type ProcessTurnInput } from "./agent-turn-store";
import { goalCheckpoint } from "./domain-write-observer";

const ownerId = LOCAL_OWNER_ID;
const contract = { title: "目标", category: "learning" as const, desiredOutcome: "理解", definitionOfDone: "复述", deadline: "2026-12-31", weeklyMinutes: 60, constraints: [], motivation: "兴趣" };
let db: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
let store: AgentTurnStore;
let input: ProcessTurnInput;
beforeEach(async () => {
  db = createDatabase(":memory:"); migrateDatabase(db); repositories = createRepositories(db); store = new AgentTurnStore(repositories);
  const goal = await repositories.goals.create(ownerId, contract);
  input = { ownerId, goalId: goal.id, requestOperationId: randomUUID(), userMessage: "学习", explicitIntent: false };
});
afterEach(() => db.$client.close());
async function admit(): Promise<AdmittedTurn> {
  const result = await store.admit(input);
  if (result.kind !== "admitted") throw new Error("Unexpected replay");
  return result.turn;
}

it("rejects malformed input, foreign owners and absent goals before writing claims", async () => {
  await expect(store.admit({ ...input, userMessage: " " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(store.admit({ ...input, ownerId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(store.admit({ ...input, goalId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(db.$client.prepare("SELECT * FROM operations").all()).toEqual([]);
});

it.each([
  { status: "pending", result: { bad: true } },
  { status: "succeeded", result: { schemaVersion: 1, kind: "agent_turn", phase: "running", runId: randomUUID() } },
  { status: "failed", result: { schemaVersion: 1, kind: "agent_turn", phase: "done", outcome: { ok: true, data: { message: "saved", state: "intake", persistedChange: false, usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0 } } } } },
] as const)("rejects corrupt/cross-phase stored claims %# without replay or new writes", async patch => {
  const turn = await admit();
  const operation = (await repositories.support.getOperation(ownerId, turn.operationEntityId))!;
  await repositories.support.updateOperation(ownerId, operation.id, operation.version, { status: patch.status, result: JsonObjectSchema.parse(patch.result) });
  await expect(store.admit(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(db.$client.prepare("SELECT * FROM agent_runs").all()).toHaveLength(1);
});

it("rejects changed goal scope and intent binding even with the same request ID", async () => {
  await admit();
  const other = await repositories.goals.create(ownerId, contract);
  await expect(store.admit({ ...input, goalId: other.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(store.admit({ ...input, explicitIntent: true })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

it("requires the same running claim/run when reading or finalizing an admitted turn", async () => {
  const turn = await admit();
  const operation = (await repositories.support.getOperation(ownerId, turn.operationEntityId))!;
  await repositories.support.updateOperation(ownerId, operation.id, operation.version, { result: { schemaVersion: 1, kind: "agent_turn", phase: "running", runId: randomUUID() } });
  await expect(store.current(turn)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  const original = new AppError("APPROVAL_REQUIRED", 403, "private");
  expect(await store.fail(turn, original, goalCheckpoint(turn.initialGoal), false, { toolCalls: 0, latencyMs: 0 })).toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect((await repositories.support.getOperation(ownerId, operation.id))!.status).toBe("pending");
});

it("does not apply a visible reply against a concurrently changed Goal", async () => {
  const turn = await admit();
  await repositories.goals.update(ownerId, input.goalId, turn.initialGoal.version, { title: "另一个修改" });
  await expect(store.succeed(turn, goalCheckpoint(turn.initialGoal), { message: "old", state: "clarifying", persistedChange: false, usage: { modelCalls: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0 } }, 1, { toolCalls: 0, latencyMs: 0 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.conversations.last(ownerId, input.goalId, 20)).toHaveLength(1);
});

it("reports unverified current state as null if recovery, finalization and the fallback read all fail", async () => {
  const turn = await admit();
  vi.spyOn(repositories, "withTransaction").mockRejectedValue(new Error("database unavailable"));
  vi.spyOn(repositories.goals, "get").mockRejectedValue(new Error("read unavailable"));
  expect(await store.fail(turn, new AppError("MODEL_TIMEOUT", 504, "private"), goalCheckpoint(turn.initialGoal), true, { toolCalls: 1, latencyMs: 1 })).toMatchObject({ code: "MODEL_TIMEOUT", turn: { state: null, persistedChange: true } });
});

it("returns null state after successful absence detection even if both finalizations failed", async () => {
  const turn = await admit();
  await repositories.goals.delete(ownerId, input.goalId);
  vi.spyOn(repositories, "withTransaction").mockRejectedValue(new Error("database unavailable"));
  expect(await store.fail(turn, new AppError("MODEL_TIMEOUT", 504, "private"), goalCheckpoint(turn.initialGoal), false, { toolCalls: 0, latencyMs: 0 })).toMatchObject({ code: "MODEL_TIMEOUT", turn: { state: null } });
});

it("makes final reply, Goal clarification, run success and cached outcome one atomic store operation", async () => {
  const turn = await admit();
  const result = { message: "你的完成期限是什么？", state: "clarifying" as const, persistedChange: false, usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 } };
  db.$client.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON operations WHEN OLD.tool_name='agent_turn' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT, 'terminal failure'); END;");
  await expect(store.succeed(turn, goalCheckpoint(turn.initialGoal), result, 1, { toolCalls: 0, latencyMs: 0 })).rejects.toBeDefined();
  expect(await repositories.goals.get(ownerId, input.goalId)).toEqual(turn.initialGoal);
  expect(await repositories.conversations.last(ownerId, input.goalId, 20)).toHaveLength(1);
  expect(await repositories.support.getAgentRun(ownerId, turn.runId)).toMatchObject({ status: "running", endState: null });
  expect(await repositories.support.getOperation(ownerId, turn.operationEntityId)).toMatchObject({ status: "pending" });
  db.$client.exec("DROP TRIGGER fail_terminal;");
  expect(await store.succeed(turn, goalCheckpoint(turn.initialGoal), result, 1, { toolCalls: 0, latencyMs: 0 })).toEqual(result);
  expect(await repositories.conversations.last(ownerId, input.goalId, 20)).toHaveLength(2);
  expect(await repositories.goals.get(ownerId, input.goalId)).toMatchObject({ agentState: "clarifying", clarificationCount: 1 });
  expect(await repositories.support.getAgentRun(ownerId, turn.runId)).toMatchObject({ status: "succeeded", endState: "clarifying" });
  expect((await repositories.support.getOperation(ownerId, turn.operationEntityId))!.result).toMatchObject({ phase: "done", outcome: { ok: true, data: result } });
});

it.each([4, 0.5])("validates staged clarification count %s before committing any success surface", async count => {
  const turn = await admit();
  const result = { message: "请补充完成期限。", state: "clarifying" as const, persistedChange: false, usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 } };
  await expect(store.succeed(turn, goalCheckpoint(turn.initialGoal), result, count, { toolCalls: 0, latencyMs: 0 })).rejects.toBeDefined();
  expect(await repositories.goals.get(ownerId, input.goalId)).toEqual(turn.initialGoal);
  expect(await repositories.conversations.last(ownerId, input.goalId, 20)).toHaveLength(1);
  expect(await repositories.support.getAgentRun(ownerId, turn.runId)).toMatchObject({ status: "running" });
  expect(await repositories.support.getOperation(ownerId, turn.operationEntityId)).toMatchObject({ status: "pending" });
});

it("rejects an illegal staged state transition without partial terminal writes", async () => {
  const turn = await admit();
  const result = { message: "目标已完成。", state: "completed" as const, persistedChange: false, usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 } };
  await expect(store.succeed(turn, goalCheckpoint(turn.initialGoal), result, 0, { toolCalls: 0, latencyMs: 0 })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  expect(await repositories.goals.get(ownerId, input.goalId)).toEqual(turn.initialGoal);
  expect(await repositories.conversations.last(ownerId, input.goalId, 20)).toHaveLength(1);
  expect(await repositories.support.getAgentRun(ownerId, turn.runId)).toMatchObject({ status: "running" });
});

it("does not turn an inspection exception carrying a cancellation code into verified cancellation", async () => {
  const turn = await admit();
  const secondary = new AppError("NOT_FOUND", 404, "unverified read");
  vi.spyOn(repositories, "withTransaction").mockRejectedValueOnce(secondary);
  await expect(store.checkCurrent(turn)).rejects.toBe(secondary);
  expect(await store.checkCurrent(turn)).toMatchObject({ status: "live", current: { goal: turn.initialGoal } });
  await repositories.goals.delete(ownerId, input.goalId);
  expect(await store.checkCurrent(turn)).toEqual({ status: "cancelled", reason: "turn_deleted" });
});
