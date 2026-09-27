import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import type { TransactionRepositories } from "../repositories/repository-types";
import { ApprovalService } from "../security/approval-service";
import { OperationService } from "./operation-service";

const ownerId = "00000000-0000-4000-8000-000000000001";
const otherOwnerId = "00000000-0000-4000-8000-000000000002";
const goalInput = {
  title: "学习",
  category: "learning" as const,
  desiredOutcome: "读懂",
  definitionOfDone: "完成",
  deadline: "2026-12-31",
  weeklyMinutes: 60,
  constraints: [],
  motivation: "兴趣",
};
let database: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
let operations: OperationService;

beforeEach(() => {
  database = createDatabase(":memory:");
  migrateDatabase(database);
  repositories = createRepositories(database);
  operations = new OperationService(repositories);
});

afterEach(() => database?.$client.close());

it("returns an exact succeeded replay without running the mutation twice", async () => {
  const goal = await repositories.goals.create(ownerId, goalInput);
  let executions = 0;
  const input = {
    ownerId,
    operationId: "  request-1:call-1  ",
    toolName: "update_task_status",
    scope: { kind: "goal" as const, goalId: goal.id },
    parameters: { taskId: randomUUID(), status: "done" },
    execute: () => {
      executions += 1;
      return { changed: true, sequence: executions };
    },
  };

  const first = await operations.executeOnce(input);
  const second = await operations.executeOnce({ ...input, operationId: "request-1:call-1" });

  expect(first).toEqual({ changed: true, sequence: 1 });
  expect(second).toEqual(first);
  expect(executions).toBe(1);
  expect(await repositories.support.getOperationByOperationId(ownerId, "request-1:call-1"))
    .toMatchObject({ goalId: goal.id, status: "succeeded", result: first });
});

it("replays before a used grant and changed goal state are checked again", async () => {
  const goal = await repositories.goals.create(ownerId, goalInput);
  const approvals = new ApprovalService(repositories.support);
  const grant = await approvals.issue({
    ownerId,
    subjectId: goal.id,
    toolName: "save_approved_plan",
    payload: { expectedGoalVersion: goal.version },
  });
  let mutations = 0;
  const execute = ({ repositories: tx }: {
    repositories: TransactionRepositories;
  }) => {
    approvals.consumeInTransaction(tx.support, {
      ownerId,
      grantId: grant.id,
      subjectId: goal.id,
      toolName: "save_approved_plan",
      payload: { expectedGoalVersion: goal.version },
    });
    const updated = tx.goals.update(ownerId, goal.id, goal.version, { title: "已批准" });
    mutations += 1;
    return { goalId: updated.id, version: updated.version };
  };
  const request = {
    ownerId,
    operationId: "structural:1",
    toolName: "save_approved_plan",
    scope: { kind: "goal" as const, goalId: goal.id },
    parameters: { grantId: grant.id, expectedGoalVersion: goal.version },
    execute,
  };

  const first = await operations.executeOnce(request);
  const replay = await operations.executeOnce(request);

  expect(replay).toEqual(first);
  expect(mutations).toBe(1);
  expect(await repositories.goals.get(ownerId, goal.id)).toMatchObject({
    title: "已批准",
    version: goal.version + 1,
  });
  expect(await repositories.support.getApprovalGrant(ownerId, grant.id))
    .toMatchObject({ usedAt: expect.any(String) });
});

it("rejects reuse with a different tool, parameter hash or trusted scope", async () => {
  const firstGoal = await repositories.goals.create(ownerId, goalInput);
  const secondGoal = await repositories.goals.create(ownerId, goalInput);
  const base = {
    ownerId,
    operationId: "scope:1",
    toolName: "update_task_status",
    scope: { kind: "goal" as const, goalId: firstGoal.id },
    parameters: { status: "done" },
    execute: () => ({ ok: true }),
  };
  await operations.executeOnce(base);

  for (const changed of [
    { toolName: "delete_task" },
    { parameters: { status: "todo" } },
    { scope: { kind: "goal" as const, goalId: secondGoal.id } },
  ]) {
    await expect(operations.executeOnce({ ...base, ...changed }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  }
});

it("never treats another owner's operation as a replay", async () => {
  const deletionParameters = { goalId: randomUUID(), expectedVersion: 1 };
  await operations.executeOnce({
    ownerId,
    operationId: "owner-bound:1",
    toolName: "delete_goal",
    scope: { kind: "ownerTombstone" },
    parameters: deletionParameters,
    execute: () => ({ ok: true }),
  });
  let otherExecuted = false;

  await expect(operations.executeOnce({
    ownerId: otherOwnerId,
    operationId: "owner-bound:1",
    toolName: "delete_goal",
    scope: { kind: "ownerTombstone" },
    parameters: deletionParameters,
    execute: () => {
      otherExecuted = true;
      return { ok: true };
    },
  })).rejects.toBeDefined();
  expect(otherExecuted).toBe(false);
});

it("stores deletion parameters only as a hash in an owner tombstone", async () => {
  const goalId = randomUUID();
  const confirmation = "删除目标：绝密目标";
  const result = await operations.executeOnce({
    ownerId,
    operationId: "delete:1",
    toolName: "delete_goal",
    scope: { kind: "ownerTombstone" },
    parameters: { goalId, confirmation, expectedVersion: 3 },
    execute: ({ operation }) => ({ deletedGoalId: goalId, operationEntityId: operation.id }),
  });
  const stored = await repositories.support.getOperationByOperationId(ownerId, "delete:1");

  expect(result.deletedGoalId).toBe(goalId);
  expect(stored).toMatchObject({ goalId: null, status: "succeeded" });
  expect(JSON.stringify(stored)).not.toContain(confirmation);
  await expect(operations.executeOnce({
    ownerId,
    operationId: "wrong-tombstone",
    toolName: "update_task_status",
    scope: { kind: "ownerTombstone" },
    parameters: {},
    execute: () => ({ ok: true }),
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

it("requires delete and clear operations to use an owner tombstone", async () => {
  const goal = await repositories.goals.create(ownerId, goalInput);
  let executed = false;

  await expect(operations.executeOnce({
    ownerId,
    operationId: "delete:wrong-scope",
    toolName: "delete_goal",
    scope: { kind: "goal", goalId: goal.id },
    parameters: { goalId: goal.id, confirmation: "删除目标" },
    execute: () => {
      executed = true;
      return { deletedGoalId: goal.id };
    },
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(executed).toBe(false);
  expect(await repositories.support.getOperationByOperationId(ownerId, "delete:wrong-scope"))
    .toBeNull();
});

it("passes the persisted operation entity ID needed to retain a clear tombstone", async () => {
  await repositories.goals.create(ownerId, goalInput);
  const first = await operations.executeOnce({
    ownerId,
    operationId: "clear:entity-id",
    toolName: "clear_all_data",
    scope: { kind: "ownerTombstone" },
    parameters: { subjectId: ownerId, confirmation: "清除我的全部本地数据" },
    execute: ({ operation, repositories: tx }) => ({
      deletedCounts: tx.support.clearOwnerData(ownerId, operation.id),
    }),
  });
  const replay = await operations.executeOnce({
    ownerId,
    operationId: "clear:entity-id",
    toolName: "clear_all_data",
    scope: { kind: "ownerTombstone" },
    parameters: { subjectId: ownerId, confirmation: "清除我的全部本地数据" },
    execute: () => ({ shouldNotRun: true }),
  });

  expect(first.deletedCounts.goals).toBe(1);
  expect(replay).toEqual(first);
  expect(await repositories.goals.list(ownerId)).toEqual([]);
  expect(await repositories.support.getOperationByOperationId(ownerId, "clear:entity-id"))
    .toMatchObject({ status: "succeeded", goalId: null, result: first });
});

it("rolls back grant consumption and the pending operation when a mutation fails", async () => {
  const goal = await repositories.goals.create(ownerId, goalInput);
  const approvals = new ApprovalService(repositories.support);
  const grant = await approvals.issue({
    ownerId,
    subjectId: goal.id,
    toolName: "save_approved_plan",
    payload: { goalVersion: goal.version },
  });

  await expect(operations.executeOnce({
    ownerId,
    operationId: "rollback:grant",
    toolName: "save_approved_plan",
    scope: { kind: "goal", goalId: goal.id },
    parameters: { grantId: grant.id, goalVersion: goal.version },
    execute: ({ repositories: tx }) => {
      approvals.consumeInTransaction(tx.support, {
        ownerId,
        grantId: grant.id,
        subjectId: goal.id,
        toolName: "save_approved_plan",
        payload: { goalVersion: goal.version },
      });
      throw new Error("later mutation failed");
    },
  })).rejects.toThrow("later mutation failed");

  expect(await repositories.support.getApprovalGrant(ownerId, grant.id))
    .toMatchObject({ usedAt: null, version: 1 });
  expect(await repositories.support.getOperationByOperationId(ownerId, "rollback:grant"))
    .toBeNull();
});

it("rejects an existing pending operation instead of resuming it", async () => {
  const pending = await repositories.support.createOperation(ownerId, {
    goalId: null,
    operationId: "pending:1",
    toolName: "clear_all_data",
    parameterHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  });
  let executed = false;

  await expect(operations.executeOnce({
    ownerId,
    operationId: pending.operationId,
    toolName: pending.toolName,
    scope: { kind: "ownerTombstone" },
    parameters: {},
    execute: () => {
      executed = true;
      return { ok: true };
    },
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(executed).toBe(false);
});

it("rejects and observes a thenable before canonicalization and rolls back early writes", async () => {
  const goal = await repositories.goals.create(ownerId, goalInput);
  let completion!: Promise<unknown>;
  const execute = ({ repositories: tx }: { repositories: TransactionRepositories }) => {
    completion = (async () => {
      tx.goals.update(ownerId, goal.id, goal.version, { title: "不应提交" });
      await Promise.resolve();
      tx.goals.update(ownerId, goal.id, goal.version + 1, { title: "也不应提交" });
      return { ok: true };
    })();
    return completion;
  };

  await expect(operations.executeOnce({
    ownerId,
    operationId: "async:1",
    toolName: "update_task_status",
    scope: { kind: "goal", goalId: goal.id },
    parameters: {},
    execute: execute as never,
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(completion).rejects.toBeDefined();
  expect(await repositories.goals.get(ownerId, goal.id)).toEqual(goal);
  expect(await repositories.support.getOperationByOperationId(ownerId, "async:1")).toBeNull();
});

it("rejects non-JSON callback results and rolls back the pending operation", async () => {
  await expect(operations.executeOnce({
    ownerId,
    operationId: "bad-result:1",
    toolName: "clear_all_data",
    scope: { kind: "ownerTombstone" },
    parameters: {},
    execute: (() => ({ bad: Number.NaN })) as never,
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(await repositories.support.getOperationByOperationId(ownerId, "bad-result:1"))
    .toBeNull();
});
