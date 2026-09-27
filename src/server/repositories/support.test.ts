import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "./repository-factory";
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const input = {
  title: "学习", category: "learning" as const, desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null
};
let db: AppDatabase;
let r: ReturnType<typeof createRepositories>;
beforeEach(() => {
  db = createDatabase(":memory:");
  migrateDatabase(db);
  r = createRepositories(db);
});
afterEach(() => db?.$client.close());
it("binds conversation summaries to same-owner same-goal messages and versions replacements", async () => {
  const goal = await r.goals.create(owner, input);
  const foreign = await r.goals.create(other, input);
  const first = await r.conversations.append(owner, goal.id, {
    role: "user", content: "一"
  });
  const second = await r.conversations.append(owner, goal.id, {
    role: "assistant", content: "二"
  });
  expect((await r.conversations.last(owner, goal.id, 1)).map(m => m.id)).toEqual([second.id]);
  expect(await r.conversations.last(other, goal.id, 2)).toEqual([]);
  await expect(r.conversations.append(owner, foreign.id, {
    role: "user", content: "no"
  })).rejects.toBeDefined();
  const summary = await r.conversations.replaceSummary(owner, goal.id, {
    throughMessageId: first.id, content: "摘要"
  });
  expect(await r.conversations.replaceSummary(owner, goal.id, {
    throughMessageId: second.id, content: "新摘要"
  })).toMatchObject({
    id: summary.id, version: 2
  });
  await expect(r.conversations.replaceSummary(owner, foreign.id, {
    throughMessageId: first.id, content: "bad"
  })).rejects.toBeDefined();
});
it("consumes a grant once using every binding, version and strict future expiry", async () => {
  const grant = await r.support.createApprovalGrant(owner, {
    subjectId: owner, contentHash: "a".repeat(64), allowedTool: "clear_all_data", expiresAt: new Date(Date.now() + 600000).toISOString()
  });
  const consume = {
    grantId: grant.id, subjectId: owner, contentHash: grant.contentHash, allowedTool: grant.allowedTool, now: new Date().toISOString(), expectedVersion: 1
  };
  for (const patch of [{
      subjectId: other
    }, {
      contentHash: "b".repeat(64)
    }, {
      allowedTool: "wrong"
    }, {
      expectedVersion: 2
    }, {
      now: grant.expiresAt
    }])
    expect(await r.support.consumeApprovalGrant(owner, {
      ...consume, ...patch
    })).toBeNull();
  expect(await r.support.consumeApprovalGrant(other, consume)).toBeNull();
  expect(await r.support.consumeApprovalGrant(owner, consume)).toMatchObject({
    version: 2, usedAt: consume.now
  });
  expect(await r.support.consumeApprovalGrant(owner, consume)).toBeNull();
});
it("provides owner-bound support lifecycle and append-only event records", async () => {
  const goal = await r.goals.create(owner, input);
  const check = await r.support.createCheckIn(owner, {
    goalId: goal.id, taskId: null, kind: "reflection", blockerCategory: null, note: "记录", minutesSpent: null, availableWeeklyMinutes: null
  });
  expect(await r.support.getCheckIn(other, check.id)).toBeNull();
  expect(await r.support.listCheckInsByGoal(owner, goal.id)).toEqual([check]);
  expect((await r.goals.get(owner, goal.id))?.version).toBe(2);
  const run = await r.support.createAgentRun(owner, {
    goalId: goal.id, startState: "intake", endState: null, status: "running", model: "mock", inputTokenCount: 0, outputTokenCount: 0, toolCallCount: 0, latencyMs: 0, errorCode: null
  });
  expect(await r.support.updateAgentRun(owner, run.id, 1, {
    status: "succeeded", inputTokenCount: 10
  })).toMatchObject({
    version: 2, status: "succeeded"
  });
  await expect(r.support.updateAgentRun(other, run.id, 2, {
    status: "failed"
  })).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  const audit = await r.support.createAuditEvent(owner, {
    goalId: goal.id, type: "event", entityType: "goal", entityId: goal.id, detail: {}
  });
  expect(audit).not.toHaveProperty("updatedAt");
  expect(await r.support.listAuditEventsByGoal(owner, goal.id)).toEqual([audit]);
  const pref = await r.support.createUserPreference(owner, {
    taskGranularity: "small", preferredTimeWindow: null, estimateBias: 1.5, commonBlockers: [], effectiveStrategies: []
  });
  expect(await r.support.getPreferencesByOwner(owner)).toEqual(pref);
  expect(await r.support.updateUserPreference(owner, pref.id, 1, {
    estimateBias: 1.25
  })).toMatchObject({
    version: 2, estimateBias: 1.25
  });
  await expect(r.support.createUserPreference(owner, {
    taskGranularity: "small", preferredTimeWindow: null, estimateBias: 1, commonBlockers: [], effectiveStrategies: []
  })).rejects.toBeDefined();
  const settings = await r.support.createAppSetting(owner, {
    privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null, provider: "mock", model: "mock", fallbackEnabled: false, dailyInputTokenLimit: 100, dailyOutputTokenLimit: 100
  });
  expect(await r.support.getSettingsByOwner(owner)).toEqual(settings);
  expect(await r.support.updateAppSetting(owner, settings.id, 1, {
    privacyAcceptedAt: new Date().toISOString()
  })).toMatchObject({
    version: 2
  });
});
it("exports only approved categories and clears only the owner while retaining a valid pending global operation", async () => {
  const goal = await r.goals.create(owner, input);
  const foreign = await r.goals.create(other, input);
  const message = await r.conversations.append(owner, goal.id, {
    role: "user", content: "private raw chat"
  });
  const operation = await r.support.createOperation(owner, {
    goalId: null, operationId: "clear:1", toolName: "clear_all_data", parameterHash: "a".repeat(64)
  });
  expect(await r.support.getOperationByOperationId(owner, "clear:1")).toEqual(operation);
  expect(await r.support.getOperationByOperationId(other, "clear:1")).toBeNull();
  expect(await r.support.exportOwnerData(owner)).toEqual({
    goals: [goal], tasks: [], planVersions: [], checkIns: [], evidence: [], preferences: [], conversationSummaries: [], conversationMessages: [message]
  });
  await expect(r.support.clearOwnerData(other, operation.id)).rejects.toBeDefined();
  await r.withTransaction(tx => {
    tx.support.clearOwnerData(owner, operation.id);
    tx.support.updateOperation(owner, operation.id, 1, {
      status: "succeeded", result: {
        cleared: true
      }
    });
  });
  expect(await r.goals.list(owner)).toEqual([]);
  expect(await r.goals.get(other, foreign.id)).toEqual(foreign);
  expect(await r.support.getOperation(owner, operation.id)).toMatchObject({
    status: "succeeded", result: {
      cleared: true
    }
  });
  await expect(r.support.clearOwnerData(owner, operation.id)).rejects.toBeDefined();
});
it("deletes a whole owner-scoped goal in FK-safe order without deleting another owner", async () => {
  const goal = await r.goals.create(owner, input);
  const foreign = await r.goals.create(other, input);
  await r.conversations.append(owner, goal.id, {
    role: "user", content: "hello"
  });
  await r.support.createCheckIn(owner, {
    goalId: goal.id, taskId: null, kind: "reflection", blockerCategory: null, note: "note", minutesSpent: null, availableWeeklyMinutes: null
  });
  await r.goals.delete(other, goal.id);
  expect(await r.goals.get(owner, goal.id)).not.toBeNull();
  await r.goals.delete(owner, goal.id);
  expect(await r.goals.get(owner, goal.id)).toBeNull();
  expect(await r.goals.get(other, foreign.id)).toEqual(foreign);
});
it("rolls back global clear if a later operation finalization fails", async () => {
  const goal = await r.goals.create(owner, input);
  const operation = await r.support.createOperation(owner, {
    goalId: null, operationId: "clear:rollback", toolName: "clear_all_data", parameterHash: "a".repeat(64)
  });
  await expect(r.withTransaction(tx => {
    tx.support.clearOwnerData(owner, operation.id);
    expect(tx.goals.list(owner)).toEqual([]);
    tx.support.updateOperation(owner, operation.id, 99, {
      status: "succeeded", result: {}
    });
  })).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  expect(await r.goals.get(owner, goal.id)).toEqual(goal);
  expect(await r.support.getOperation(owner, operation.id)).toEqual(operation);
});
