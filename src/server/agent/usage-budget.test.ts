import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { contentHash } from "../security/canonical-json";
import { UsageBudgetService } from "./usage-budget";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const request = { model: "mock", messages: [{ role: "user" as const, content: "你好" }], tools: [] };
const settings = { privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null, provider: "mock" as const, model: "mock", fallbackEnabled: false, dailyInputTokenLimit: 1000, dailyOutputTokenLimit: 100 };
const goalInput = { title: "学习", category: "learning" as const, desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
let db: AppDatabase;
let r: ReturnType<typeof createRepositories>;
let budget: UsageBudgetService;
let now: Date;
beforeEach(async () => {
  db = createDatabase(":memory:"); migrateDatabase(db); r = createRepositories(db);
  now = new Date("2026-09-04T15:59:00Z");
  budget = new UsageBudgetService(r, { now: () => now });
  await r.support.createAppSetting(owner, settings);
});
afterEach(() => db?.$client.close());
async function run(ownerId = owner) {
  const goal = await r.goals.create(ownerId, goalInput);
  return r.support.createAgentRun(ownerId, { goalId: goal.id, startState: "intake", endState: null, status: "running", model: "mock", inputTokenCount: 0, outputTokenCount: 0, toolCallCount: 0, latencyMs: 0, errorCode: null });
}
async function clear(recreate = true) {
  return r.withTransaction(tx => {
    const op = tx.support.createOperation(owner, { goalId: null, operationId: `clear:${randomUUID()}`, toolName: "clear_all_data", parameterHash: "a".repeat(64) });
    const deletedCounts = tx.support.clearOwnerData(owner, op.id);
    if (recreate) tx.support.createAppSetting(owner, settings);
    tx.support.updateOperation(owner, op.id, op.version, { status: "succeeded", result: { deletedCounts } });
  });
}
it("admits below budget and requires existing settings plus an owned existing run", async () => {
  const owned = await run(); const foreign = await run(other);
  expect(await budget.assertCanCall(owner, request, owned.id)).toMatchObject({ ownerId: owner, runId: owned.id, day: "2026-09-04" });
  await expect(budget.assertCanCall(other, request)).rejects.toMatchObject({ code: "MODEL_CONFIG_MISSING" });
  await expect(budget.assertCanCall(owner, request, foreign.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(budget.assertCanCall(owner, request, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("uses UTF-8 serialized bytes at the exact input boundary and current persisted settings", async () => {
  const setting = (await r.support.getSettingsByOwner(owner))!;
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  await r.support.updateAppSetting(owner, setting.id, setting.version, { dailyInputTokenLimit: bytes });
  await expect(budget.assertCanCall(owner, request)).resolves.toBeDefined();
  const admission = await budget.assertCanCall(owner, request);
  await budget.settle(admission, { inputTokens: 1, outputTokens: 0 });
  await expect(budget.assertCanCall(owner, request)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
});
it.each([{ inputTokens: 950, outputTokens: 0 }, { inputTokens: 1, outputTokens: 100 }])("rejects accumulated input or output usage", async usage => {
  const admission = await budget.assertCanCall(owner, request); await budget.settle(admission, usage);
  await expect(budget.assertCanCall(owner, request)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
});
it("settles once with a content-free receipt and updates cumulative run counters atomically", async () => {
  const currentRun = await run(); const admission = await budget.assertCanCall(owner, request, currentRun.id);
  expect(await budget.settle(admission, { inputTokens: 10, outputTokens: 5 })).toEqual({ status: "settled", duplicate: false, runUpdated: true });
  expect(await budget.settle(admission, { inputTokens: 10, outputTokens: 5 })).toEqual({ status: "settled", duplicate: true, runUpdated: false });
  await expect(budget.settle(admission, { inputTokens: 11, outputTokens: 5 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await r.support.getAgentRun(owner, currentRun.id)).toMatchObject({ version: 2, inputTokenCount: 10, outputTokenCount: 5 });
  const receipt = { schemaVersion: 1, kind: "model_usage", attemptId: admission.attemptId, day: "2026-09-04", inputTokens: 10, outputTokens: 5 };
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-04")).toEqual([receipt]);
  expect(await r.support.getOperationByOperationId(owner, `model-usage:${admission.attemptId}`)).toMatchObject({ goalId: null, toolName: "record_model_usage", status: "succeeded", parameterHash: contentHash(receipt), result: receipt });
});
it("rolls back the receipt when updating its run fails", async () => {
  const currentRun = await run(); const admission = await budget.assertCanCall(owner, request, currentRun.id);
  db.$client.exec("CREATE TRIGGER fail_run_update BEFORE UPDATE ON agent_runs BEGIN SELECT RAISE(ABORT, 'forced'); END;");
  await expect(budget.settle(admission, { inputTokens: 10, outputTokens: 5 })).rejects.toBeDefined();
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-04")).toEqual([]);
  expect(await r.support.getAgentRun(owner, currentRun.id)).toMatchObject({ inputTokenCount: 0 });
});
it("attributes a response after midnight to dispatch day and resets the next call within the same run", async () => {
  const currentRun = await run(); const first = await budget.assertCanCall(owner, request, currentRun.id);
  now = new Date("2026-09-04T16:00:01Z");
  await budget.settle(first, { inputTokens: 950, outputTokens: 100 });
  const next = await budget.assertCanCall(owner, request, currentRun.id);
  expect(next.day).toBe("2026-09-05"); await budget.settle(next, { inputTokens: 20, outputTokens: 2 });
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-04")).toHaveLength(1);
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-05")).toEqual([expect.objectContaining({ inputTokens: 20 })]);
  expect(await r.support.getAgentRun(owner, currentRun.id)).toMatchObject({ inputTokenCount: 970, outputTokenCount: 102 });
});
it("rechecks the actual dispatch day after asynchronous preparation crosses midnight", async () => {
  const prepared = await budget.assertCanCall(owner, request);
  now = new Date("2026-09-04T16:00:00Z");
  const checked = await budget.recheckBeforeDispatch(prepared, request);
  expect(checked).toEqual({ status: "ready", admission: { ...prepared, day: "2026-09-05" } });
  if (checked.status !== "ready") throw new Error("Dispatch unexpectedly cancelled");
  await budget.settle(checked.admission, { inputTokens: 10, outputTokens: 0 });
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-04")).toEqual([]);
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-05")).toEqual([expect.objectContaining({ inputTokens: 10 })]);
  const another = await budget.assertCanCall(owner, request); await budget.settle(another, { inputTokens: 0, outputTokens: 100 });
  await expect(budget.recheckBeforeDispatch(prepared, request)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
});
it("rejects changed receipt day on retry without moving an already settled call", async () => {
  const admission = await budget.assertCanCall(owner, request);
  await budget.settle(admission, { inputTokens: 10, outputTokens: 5 });
  await expect(budget.settle({ ...admission, day: "2026-09-05" }, { inputTokens: 10, outputTokens: 5 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-05")).toEqual([]);
});
it("a second clear removes intervening usage and does not revive either older generation", async () => {
  const first = await budget.assertCanCall(owner, request); await clear();
  const second = await budget.assertCanCall(owner, request); await budget.settle(second, { inputTokens: 10, outputTokens: 100 });
  await clear();
  for (const admission of [first, second]) expect(await budget.settle(admission, { inputTokens: 10, outputTokens: 100 })).toMatchObject({ status: "cancelled" });
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-04")).toEqual([]);
  await expect(budget.assertCanCall(owner, request)).resolves.toBeDefined();
});
it("preserves allowance after goal deletion and settles late counts without recreating a run", async () => {
  const currentRun = await run(); const settled = await budget.assertCanCall(owner, request, currentRun.id);
  const inFlight = await budget.assertCanCall(owner, request, currentRun.id);
  await budget.settle(settled, { inputTokens: 10, outputTokens: 50 });
  await r.goals.delete(owner, currentRun.goalId);
  expect(await budget.recheckBeforeDispatch(inFlight, request)).toEqual({ status: "cancelled", reason: "run_deleted" });
  expect(await budget.settle(inFlight, { inputTokens: 20, outputTokens: 50 })).toEqual({ status: "settled", duplicate: false, runUpdated: false });
  expect(await r.support.getAgentRun(owner, currentRun.id)).toBeNull(); expect(await r.goals.list(owner)).toEqual([]);
  await expect(budget.assertCanCall(owner, request)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
});
it.each([true, false])("discards pre-clear settlement and replay when settings recreated=%s", async recreate => {
  const currentRun = await run(); const first = await budget.assertCanCall(owner, request, currentRun.id);
  const pending = await budget.assertCanCall(owner, request, currentRun.id);
  await budget.settle(first, { inputTokens: 950, outputTokens: 100 }); await clear(recreate);
  for (const admission of [first, pending]) {
    expect(await budget.settle(admission, { inputTokens: 950, outputTokens: 100 })).toEqual({ status: "cancelled", reason: "workspace_cleared" });
    expect(await budget.recheckBeforeDispatch(admission, request)).toEqual({ status: "cancelled", reason: "workspace_cleared" });
  }
  expect(await r.support.listModelUsageReceipts(owner, "2026-09-04")).toEqual([]);
  expect(await r.goals.list(owner)).toEqual([]);
  if (recreate) await expect(budget.assertCanCall(owner, request)).resolves.toBeDefined();
});
it("ordinary setting edits retain generation and owner receipts remain isolated", async () => {
  await r.support.createAppSetting(other, settings);
  const admission = await budget.assertCanCall(owner, request);
  const current = (await r.support.getSettingsByOwner(owner))!;
  await r.support.updateAppSetting(owner, current.id, current.version, { dailyOutputTokenLimit: 200 });
  expect((await budget.recheckBeforeDispatch(admission, request)).status).toBe("ready");
  await budget.settle(admission, { inputTokens: 0, outputTokens: 200 });
  await expect(budget.assertCanCall(other, request)).resolves.toBeDefined();
  expect(await r.support.listModelUsageReceipts(other, "2026-09-04")).toEqual([]);
});
it.each(["extra", "hash", "identity", "status", "scope", "toolName"])("fails closed on malformed receipt %s", async fault => {
  const attemptId = randomUUID();
  const result = { schemaVersion: 1, kind: "model_usage", attemptId, day: "2026-09-04", inputTokens: 1, outputTokens: 1, ...(fault === "extra" ? { prompt: "must not persist" } : {}) };
  const goal = await r.goals.create(owner, goalInput);
  const op = await r.support.createOperation(owner, { goalId: fault === "scope" ? goal.id : null, operationId: `model-usage:${fault === "identity" ? randomUUID() : attemptId}`, toolName: fault === "toolName" ? "other_tool" : "record_model_usage", parameterHash: fault === "hash" ? "a".repeat(64) : contentHash(result) });
  await r.support.updateOperation(owner, op.id, op.version, { status: fault === "status" ? "failed" : "succeeded", result });
  await expect(budget.assertCanCall(owner, request)).rejects.toBeDefined();
});
