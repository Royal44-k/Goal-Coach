import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Goal, Task } from "@/core/domain/contracts";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "./repository-factory";
import { deriveExecutionResets, PlanRevisionEnvelopeSchema, type PlanRevisionPayload, type TaskCreateInput } from "./revision-contracts";
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
let db: AppDatabase;
let r: ReturnType<typeof createRepositories>;
let goal: Goal;
beforeEach(async () => {
  db = createDatabase(":memory:");
  migrateDatabase(db);
  r = createRepositories(db);
  goal = await r.goals.create(owner, {
    title: "学习", category: "learning", desiredOutcome: "读懂", definitionOfDone: "完成", deadline: "2026-12-31", weeklyMinutes: 60, constraints: [], motivation: "兴趣"
  });
});
afterEach(() => db?.$client.close());
const proposal = (id = randomUUID()): TaskCreateInput => ({
  id, title: "读书", action: "读一章", doneCriteria: "能复述", evidenceType: "text", estimateMinutes: 20, dueAt: null, dependencyIds: []
});
const comparable = (task: Task): TaskCreateInput => ({
  id: task.id, title: task.title, action: task.action, doneCriteria: task.doneCriteria, evidenceType: task.evidenceType, estimateMinutes: task.estimateMinutes, dueAt: task.dueAt, dependencyIds: task.dependencyIds
});
async function draft(inputs: TaskCreateInput[], resets: PlanRevisionPayload["executionResets"] = []) {
  const latest = (await r.goals.get(owner, goal.id))!;
  const payload: PlanRevisionPayload = {
    schemaVersion: 2, milestones: ["基础", "应用"], base: {
      planVersionId: latest.currentPlanVersionId, goalVersion: latest.version
    }, changeReason: null, changeSource: "user", tasks: inputs, executionResets: resets, diff: {
      added: [], removed: [], moved: [], changed: []
    }
  };
  const artifact = await r.plans.saveDraftArtifact(owner, {
    goalId: goal.id, kind: latest.currentPlanVersionId ? "replan" : "plan", payload, contentHash: "a".repeat(64)
  });
  return r.plans.createDraft(owner, goal.id, {
    draftArtifactId: artifact.id, expectedDraftArtifactVersion: artifact.version
  });
}
async function initial() {
  const plan = await draft([proposal()]);
  const approved = await r.plans.approve(owner, plan.id, plan.version);
  return {
    plan: approved, task: (await r.tasks.listByGoal(owner, goal.id, approved.id))[0]
  };
}
it("allocates complete fresh task IDs, remaps dependencies and preserves plan history", async () => {
  const a = proposal();
  const b = {
    ...proposal(), dependencyIds: [a.id]
  };
  const plan = await draft([a, b]);
  await r.tasks.createMany(owner, goal.id, plan.id, [a, b]);
  const staged = (await r.plans.listVersions(owner, goal.id))[0];
  expect(staged.version).toBe(2);
  const approved = await r.plans.approve(owner, plan.id, staged.version);
  const tasks = await r.tasks.listByGoal(owner, goal.id, plan.id);
  expect(tasks.map(t => t.id)).not.toContain(a.id);
  expect(tasks[1].dependencyIds).toEqual([tasks[0].id]);
  const second = await draft(tasks.map(comparable));
  await r.plans.approve(owner, second.id, second.version);
  expect(await r.goals.get(owner, goal.id)).toMatchObject({
    currentPlanVersionId: second.id, status: "active", agentState: "active"
  });
  expect(await r.tasks.get(owner, tasks[0].id)).toEqual(tasks[0]);
  expect((await r.plans.listVersions(owner, goal.id)).find(p => p.id === approved.id)?.status).toBe("superseded");
  expect(await r.tasks.listByGoal(other, goal.id, second.id)).toEqual([]);
  expect((await r.tasks.listByGoal(owner, goal.id, second.id)).map(t => t.id)).not.toContain(tasks[0].id);
  await expect(r.tasks.createMany(owner, goal.id, second.id, [proposal()])).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
});
it("carries authoritative execution and evidence with provenance without changing original history", async () => {
  const { task } = await initial();
  const finished = await r.tasks.update(owner, task.id, task.version, {
    status: "done", actualMinutes: 25
  });
  const evidence = await r.support.createTaskEvidence(owner, {
    goalId: goal.id, taskId: task.id, type: "text", text: "复述", fileName: null, fileSize: null, mimeType: null
  });
  const next = await draft([{
      ...comparable(finished), dueAt: "2026-12-01"
    }]);
  const approved = await r.plans.approve(owner, next.id, next.version);
  const successor = (await r.tasks.listByGoal(owner, goal.id, next.id))[0];
  expect(successor).toMatchObject({
    status: "done", actualMinutes: 25
  });
  expect(await r.tasks.get(owner, task.id)).toEqual(finished);
  expect(await r.support.getTaskEvidence(owner, evidence.id)).toEqual(evidence);
  const copies = await r.support.listEvidenceByTask(owner, successor.id);
  expect(copies).toHaveLength(1);
  expect(copies[0].id).not.toBe(evidence.id);
  expect(PlanRevisionEnvelopeSchema.parse(approved.diff).revision.evidenceMap).toEqual([{
      sourceEvidenceId: evidence.id, copiedEvidenceId: copies[0].id
    }]);
  await expect(r.tasks.update(owner, task.id, finished.version, {
    status: "todo"
  })).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  await expect(r.support.createTaskEvidence(owner, {
    goalId: goal.id, taskId: task.id, type: "text", text: "late", fileName: null, fileSize: null, mimeType: null
  })).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  await expect(r.support.createCheckIn(owner, {
    goalId: goal.id, taskId: task.id, kind: "progress", blockerCategory: null, note: "late", minutesSpent: null, availableWeeklyMinutes: null
  })).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
});
it("rejects an approval after execution changes the aggregate goal snapshot", async () => {
  const { task } = await initial();
  const next = await draft([comparable(task)]);
  await r.tasks.update(owner, task.id, task.version, {
    status: "doing"
  });
  await expect(r.plans.approve(owner, next.id, next.version)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
});
it("requires disclosed meaning and prerequisite resets from the shared pure rule", async () => {
  const a = proposal();
  const b = {
    ...proposal(), dependencyIds: [a.id]
  };
  const first = await draft([a, b]);
  await r.plans.approve(owner, first.id, first.version);
  const source = await r.tasks.listByGoal(owner, goal.id, first.id);
  for (const t of source)
    await r.tasks.update(owner, t.id, t.version, {
      status: "done", actualMinutes: 10
    });
  const actual = await r.tasks.listByGoal(owner, goal.id, first.id);
  const proposed = actual.map(comparable);
  proposed[0].action = "另一章";
  expect(deriveExecutionResets(actual, proposed)).toEqual([{
      taskKey: actual[0].id, reason: "completion_meaning_changed"
    }, {
      taskKey: actual[1].id, reason: "prerequisite_reset"
    }]);
  await expect(draft(proposed)).rejects.toBeDefined();
  const next = await draft(proposed, [{
      taskKey: actual[0].id, reason: "completion_meaning_changed"
    }, {
      taskKey: actual[1].id, reason: "prerequisite_reset"
    }]);
  await r.plans.approve(owner, next.id, next.version);
  expect((await r.tasks.listByGoal(owner, goal.id, next.id)).map(t => [t.status, t.actualMinutes])).toEqual([["todo", null], ["todo", null]]);
});
it("rolls back task materialization and the complete switch when evidence copy fails", async () => {
  const { task, plan } = await initial();
  await r.support.createTaskEvidence(owner, {
    goalId: goal.id, taskId: task.id, type: "text", text: "e", fileName: null, fileSize: null, mimeType: null
  });
  const next = await draft([comparable(task)]);
  db.$client.exec("CREATE TRIGGER reject_copy BEFORE INSERT ON task_evidence BEGIN SELECT RAISE(ABORT, 'copy failed'); END");
  await expect(r.plans.approve(owner, next.id, next.version)).rejects.toBeDefined();
  expect((await r.goals.get(owner, goal.id))?.currentPlanVersionId).toBe(plan.id);
  expect(await r.tasks.listByGoal(owner, goal.id, next.id)).toEqual([]);
  expect((await r.plans.getCurrent(owner, goal.id))?.status).toBe("approved");
});
it("rolls back first task and draft in an outer transaction after second task insertion fails", async () => {
  const a = proposal();
  const b = {
    ...proposal(), title: "fail-second"
  };
  const artifact = await r.plans.saveDraftArtifact(owner, {
    goalId: goal.id, kind: "plan", contentHash: "a".repeat(64), payload: {
      schemaVersion: 2, milestones: ["基础", "应用"], base: {
        planVersionId: null, goalVersion: goal.version
      }, changeReason: null, changeSource: "user", tasks: [a, b], executionResets: [], diff: {
        added: [], removed: [], moved: [], changed: []
      }
    }
  });
  db.$client.exec("CREATE TRIGGER reject_second BEFORE INSERT ON tasks WHEN NEW.title = 'fail-second' AND (SELECT count(*) FROM tasks) = 1 BEGIN SELECT RAISE(ABORT, 'second failed after first'); END");
  await expect(r.withTransaction(tx => {
    const plan = tx.plans.createDraft(owner, goal.id, {
      draftArtifactId: artifact.id, expectedDraftArtifactVersion: artifact.version
    });
    tx.tasks.createMany(owner, goal.id, plan.id, [a, b]);
  })).rejects.toThrow("second failed after first");
  expect(await r.plans.listVersions(owner, goal.id)).toEqual([]);
  expect(db.$client.prepare("SELECT count(*) AS count FROM tasks").get()).toEqual({
    count: 0
  });
});
it("rejects duplicate, dangling, self/cyclic, cross-plan keys and tampered complete lists", async () => {
  const a = proposal();
  await expect(draft([a, a])).rejects.toBeDefined();
  await expect(draft([{
      ...a, dependencyIds: [randomUUID()]
    }])).rejects.toBeDefined();
  await expect(draft([{
      ...a, dependencyIds: [a.id]
    }])).rejects.toBeDefined();
  const plan = await draft([a]);
  await expect(r.tasks.createMany(owner, goal.id, plan.id, [{
      ...a, title: "tampered"
    }])).rejects.toBeDefined();
  await r.plans.approve(owner, plan.id, plan.version);
  const old = (await r.tasks.listByGoal(owner, goal.id, plan.id))[0];
  const next = await draft([comparable(old)]);
  await r.plans.approve(owner, next.id, next.version);
  await expect(draft([comparable(old)])).rejects.toBeDefined();
});
it("checks evidence/check-in and competing-approval snapshots plus artifact finalization", async () => {
  const { task } = await initial();
  const evidenceDraft = await draft([comparable(task)]);
  await r.support.createTaskEvidence(owner, {
    goalId: goal.id, taskId: task.id, type: "user_declaration", text: "完成", fileName: null, fileSize: null, mimeType: null
  });
  await expect(r.plans.approve(owner, evidenceDraft.id, evidenceDraft.version)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  const checkDraft = await draft([comparable(task)]);
  await r.support.createCheckIn(owner, {
    goalId: goal.id, taskId: task.id, kind: "progress", note: "前进", blockerCategory: null, minutesSpent: 5, availableWeeklyMinutes: null
  });
  await expect(r.plans.approve(owner, checkDraft.id, checkDraft.version)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  const a = await draft([comparable(task)]);
  const b = await draft([comparable(task)]);
  await r.plans.approve(owner, a.id, a.version);
  await expect(r.plans.approve(owner, b.id, b.version)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  const current = (await r.tasks.listByGoal(owner, goal.id, a.id))[0];
  const c = await draft([comparable(current)]);
  const binding = PlanRevisionEnvelopeSchema.parse(c.diff).revision;
  const artifact = await r.plans.updateDraftArtifact(owner, binding.draftArtifactId, binding.draftArtifactVersion, {
    status: "superseded"
  });
  expect(artifact.version).toBe(binding.draftArtifactVersion + 1);
  await expect(r.plans.approve(owner, c.id, c.version)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  await expect(r.plans.updateDraftArtifact(owner, artifact.id, artifact.version, {
    status: "pending"
  })).rejects.toBeDefined();
});
it("protects task references and old undos, and permits an explicit empty successor", async () => {
  const { task } = await initial();
  const undo = await r.support.createUndoRecord(owner, {
    goalId: goal.id, taskId: task.id, forwardPatch: {
      status: "doing"
    }, reversePatch: {
      status: "todo"
    }
  });
  expect(await r.support.getLatestPendingUndo(owner, goal.id)).toEqual(undo);
  await expect(r.tasks.delete(owner, task.id)).rejects.toMatchObject({
    code: "INVALID_TRANSITION"
  });
  const next = await draft([]);
  await r.plans.approve(owner, next.id, next.version);
  expect(await r.tasks.listByGoal(owner, goal.id, next.id)).toEqual([]);
  expect(await r.tasks.get(owner, task.id)).toEqual(task);
  expect(await r.support.getLatestPendingUndo(owner, goal.id)).toEqual(undo);
  await expect(r.support.updateUndoRecord(owner, undo.id, undo.version, {
    undoneAt: new Date().toISOString()
  })).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  await expect(r.support.createUndoRecord(owner, {
    goalId: goal.id, taskId: task.id, forwardPatch: {}, reversePatch: {}
  })).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  await expect(r.tasks.delete(owner, task.id)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
});
it("deletes only unused current tasks and invalidates open drafts", async () => {
  const { task } = await initial();
  const pending = await draft([comparable(task)]);
  const before = (await r.goals.get(owner, goal.id))!;
  await r.tasks.delete(owner, task.id);
  expect(await r.tasks.get(owner, task.id)).toBeNull();
  expect((await r.goals.get(owner, goal.id))?.version).toBe(before.version + 1);
  await expect(r.plans.approve(owner, pending.id, pending.version)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
});
it("retains three revision histories without copying historical events or doubling evidence", async () => {
  const { task } = await initial();
  const check = await r.support.createCheckIn(owner, {
    goalId: goal.id, taskId: task.id, kind: "progress", note: "完成", blockerCategory: null, minutesSpent: null, availableWeeklyMinutes: null
  });
  const original = await r.support.createTaskEvidence(owner, {
    goalId: goal.id, taskId: task.id, type: "text", text: "证据", fileName: null, fileSize: null, mimeType: null
  });
  let latest = task;
  for (let n = 0; n < 2; n++) {
    const next = await draft([comparable(latest)]);
    await r.plans.approve(owner, next.id, next.version);
    latest = (await r.tasks.listByGoal(owner, goal.id, next.id))[0];
    expect(await r.support.listEvidenceByTask(owner, latest.id)).toHaveLength(1);
  }
  expect(await r.support.getTaskEvidence(owner, original.id)).toEqual(original);
  expect(await r.support.listCheckInsByGoal(owner, goal.id)).toEqual([check]);
  expect(await r.plans.listVersions(owner, goal.id)).toHaveLength(3);
});
it("validates mapping integrity at the exported envelope boundary", async () => {
  const a = proposal();
  const b = proposal();
  const plan = await draft([a, b]);
  await r.tasks.createMany(owner, goal.id, plan.id, [a, b]);
  const staged = (await r.plans.listVersions(owner, goal.id))[0];
  const envelope = PlanRevisionEnvelopeSchema.parse(staged.diff);
  envelope.revision.taskMap[1].storedTaskId = envelope.revision.taskMap[0].storedTaskId;
  expect(PlanRevisionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});
it("refuses malformed staged task sets before approval changes any current history", async () => {
  const a = proposal();
  const plan = await draft([a]);
  await r.tasks.createMany(owner, goal.id, plan.id, [a]);
  const staged = (await r.plans.listVersions(owner, goal.id))[0];
  db.$client.prepare("UPDATE tasks SET action = ? WHERE plan_version_id = ?").run("tampered", plan.id);
  await expect(r.plans.approve(owner, plan.id, staged.version)).rejects.toMatchObject({
    code: "VERSION_CONFLICT"
  });
  expect((await r.goals.get(owner, goal.id))?.currentPlanVersionId).toBeNull();
});
it("rolls back approval and materialization when the final goal activation is invalid", async () => {
  goal = await r.goals.update(owner, goal.id, goal.version, {
    desiredOutcome: null
  });
  const next = await draft([proposal()]);
  await expect(r.plans.approve(owner, next.id, next.version)).rejects.toBeDefined();
  expect(await r.goals.get(owner, goal.id)).toEqual(goal);
  expect(await r.tasks.listByGoal(owner, goal.id, next.id)).toEqual([]);
  expect((await r.plans.listVersions(owner, goal.id))[0]).toEqual(next);
});
it("rejects current prerequisite deletion and completes the current undo lifecycle once", async () => {
  const a = proposal();
  const b = {
    ...proposal(), dependencyIds: [a.id]
  };
  const plan = await draft([a, b]);
  await r.plans.approve(owner, plan.id, plan.version);
  const tasks = await r.tasks.listByGoal(owner, goal.id, plan.id);
  await expect(r.tasks.delete(owner, tasks[0].id)).rejects.toMatchObject({
    code: "INVALID_TRANSITION"
  });
  const undo = await r.support.createUndoRecord(owner, {
    goalId: goal.id, taskId: tasks[1].id, forwardPatch: {
      status: "doing"
    }, reversePatch: {
      status: "todo"
    }
  });
  expect(await r.support.getUndoRecord(other, undo.id)).toBeNull();
  expect(await r.support.updateUndoRecord(owner, undo.id, undo.version, {
    undoneAt: new Date().toISOString()
  })).toMatchObject({
    version: 2
  });
  expect(await r.support.getLatestPendingUndo(owner, goal.id)).toBeNull();
  await expect(r.support.updateUndoRecord(owner, undo.id, 2, {
    undoneAt: new Date().toISOString()
  })).rejects.toBeDefined();
});
