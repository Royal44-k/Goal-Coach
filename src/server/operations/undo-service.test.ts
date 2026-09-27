import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Goal, Task } from "@/core/domain/contracts";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import type { PlanRevisionPayload, TaskCreateInput } from "../repositories/revision-contracts";
import { UndoService } from "./undo-service";

const ownerId = "00000000-0000-4000-8000-000000000001";
let database: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
let goal: Goal;
let undo: UndoService;

beforeEach(async () => {
  database = createDatabase(":memory:");
  migrateDatabase(database);
  repositories = createRepositories(database);
  undo = new UndoService(repositories);
  goal = await repositories.goals.create(ownerId, {
    title: "学习",
    category: "learning",
    desiredOutcome: "读懂",
    definitionOfDone: "完成",
    deadline: "2026-12-31",
    weeklyMinutes: 60,
    constraints: [],
    motivation: "兴趣",
  });
});

afterEach(() => database?.$client.close());

const proposedTask = (id = randomUUID()): TaskCreateInput => ({
  id,
  title: "读书",
  action: "读一章",
  doneCriteria: "能复述",
  evidenceType: "text",
  estimateMinutes: 20,
  dueAt: null,
  dependencyIds: [],
});

const comparable = (task: Task): TaskCreateInput => ({
  id: task.id,
  title: task.title,
  action: task.action,
  doneCriteria: task.doneCriteria,
  evidenceType: task.evidenceType,
  estimateMinutes: task.estimateMinutes,
  dueAt: task.dueAt,
  dependencyIds: task.dependencyIds,
});

async function approve(tasks: TaskCreateInput[]) {
  const currentGoal = (await repositories.goals.get(ownerId, goal.id))!;
  const payload: PlanRevisionPayload = {
    schemaVersion: 2, milestones: ["基础", "应用"],
    base: {
      planVersionId: currentGoal.currentPlanVersionId,
      goalVersion: currentGoal.version,
    },
    changeReason: null,
    changeSource: "user",
    tasks,
    executionResets: [],
    diff: { added: [], removed: [], moved: [], changed: [] },
  };
  const artifact = await repositories.plans.saveDraftArtifact(ownerId, {
    goalId: goal.id,
    kind: currentGoal.currentPlanVersionId ? "replan" : "plan",
    payload,
    contentHash: "a".repeat(64),
  });
  const plan = await repositories.plans.createDraft(ownerId, goal.id, {
    draftArtifactId: artifact.id,
    expectedDraftArtifactVersion: artifact.version,
  });
  return repositories.plans.approve(ownerId, plan.id, plan.version);
}

it("restores the exact prior execution fields with a new task version", async () => {
  const plan = await approve([proposedTask()]);
  const task = (await repositories.tasks.listByGoal(ownerId, goal.id, plan.id))[0];
  const { changed, record } = await repositories.withTransaction(tx => {
    const changed = tx.tasks.update(ownerId, task.id, task.version, {
      status: "done",
      actualMinutes: 25,
    });
    const record = undo.recordTaskPatchInTransaction(tx, {
      ownerId,
      goalId: goal.id,
      taskId: task.id,
      before: { status: task.status, actualMinutes: task.actualMinutes },
      after: { status: changed.status, actualMinutes: changed.actualMinutes },
    });
    return { changed, record };
  });

  const restored = await repositories.withTransaction(tx =>
    undo.undoLastInTransaction(tx, { ownerId, goalId: goal.id }));

  expect(record).toMatchObject({
    forwardPatch: { status: "done", actualMinutes: 25 },
    reversePatch: { status: "todo", actualMinutes: null },
  });
  expect(restored).toMatchObject({
    task: {
    id: task.id,
    status: "todo",
    actualMinutes: null,
    version: changed.version + 1,
    },
  });
  expect(await repositories.support.getUndoRecord(ownerId, record.id))
    .toMatchObject({ undoneAt: expect.any(String), version: record.version + 1 });
});

it("rejects structural fields in a recorded patch", async () => {
  const plan = await approve([proposedTask()]);
  const task = (await repositories.tasks.listByGoal(ownerId, goal.id, plan.id))[0];

  await expect(undo.recordTaskPatch({
    ownerId,
    goalId: goal.id,
    taskId: task.id,
    before: { status: "todo", actualMinutes: null, title: "旧" },
    after: { status: "doing", actualMinutes: null },
  } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

it("does not skip or redirect the newest undo after its plan is superseded", async () => {
  const firstPlan = await approve([proposedTask()]);
  const task = (await repositories.tasks.listByGoal(ownerId, goal.id, firstPlan.id))[0];
  const changed = await repositories.tasks.update(ownerId, task.id, task.version, { status: "doing" });
  const record = await undo.recordTaskPatch({
    ownerId,
    goalId: goal.id,
    taskId: task.id,
    before: { status: task.status, actualMinutes: task.actualMinutes },
    after: { status: changed.status, actualMinutes: changed.actualMinutes },
  });
  const nextPlan = await approve([comparable(changed)]);
  const successor = (await repositories.tasks.listByGoal(ownerId, goal.id, nextPlan.id))[0];

  await expect(undo.undoLast({ ownerId, goalId: goal.id }))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await repositories.tasks.get(ownerId, task.id)).toEqual(changed);
  expect(await repositories.tasks.get(ownerId, successor.id)).toEqual(successor);
  expect(await repositories.support.getUndoRecord(ownerId, record.id))
    .toMatchObject({ undoneAt: null });
});
