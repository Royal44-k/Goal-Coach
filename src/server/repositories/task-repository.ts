import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { PlanVersion, Task } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import * as t from "../db/schema";
import { TaskPatchSchema } from "./repository-inputs";
import { conflict, identity, type RepositoryContext } from "./repository-internals";
import { PlanRevisionEnvelopeSchema, TaskCreateInputSchema, verifyExecutionResets, type PlanRevisionPayload, type TaskCreateInput } from "./revision-contracts";
import type { SyncRepository, TaskRepository } from "./repository-types";
export function validateSnapshot(ctx: RepositoryContext, owner: string, goalId: string, payload: PlanRevisionPayload): Task[] {
  const goal = ctx.requireGoal(owner, goalId);
  if (goal.version !== payload.base.goalVersion || goal.currentPlanVersionId !== payload.base.planVersionId)
    conflict();
  const source = payload.base.planVersionId ? ctx.stores.tasks.list(owner, and(eq(t.tasks.goalId, goalId), eq(t.tasks.planVersionId, payload.base.planVersionId))) : [];
  if (payload.base.planVersionId) {
    const plan = ctx.stores.plans.get(owner, payload.base.planVersionId);
    if (!plan || plan.goalId !== goalId || plan.status !== "approved")
      conflict();
  }
  const sourceKeys = new Set(source.map(task => task.id));
  for (const task of payload.tasks)
    if (!sourceKeys.has(task.id) && ctx.stores.tasks.get(owner, task.id))
      conflict();
  if (!verifyExecutionResets(source, payload))
    conflict();
  return source;
}
export function loadSealedDraft(ctx: RepositoryContext, owner: string, plan: PlanVersion) {
  if (plan.status !== "draft")
    conflict();
  const envelope = PlanRevisionEnvelopeSchema.parse(plan.diff);
  const artifact = ctx.stores.drafts.get(owner, envelope.revision.draftArtifactId);
  if (!artifact || artifact.goalId !== plan.goalId || artifact.status !== "pending" || artifact.version !== envelope.revision.draftArtifactVersion || (artifact.kind !== "plan" && artifact.kind !== "replan"))
    conflict();
  if (JSON.stringify(artifact.payload) !== JSON.stringify(envelope.revision.payload))
    conflict();
  const source = validateSnapshot(ctx, owner, plan.goalId, envelope.revision.payload);
  return {
    envelope, source
  };
}
export function materializeTasks(ctx: RepositoryContext, owner: string, goalId: string, planId: string, inputs: TaskCreateInput[]): Task[] {
  const parsed = z.array(TaskCreateInputSchema).parse(inputs);
  const plan = ctx.stores.plans.get(owner, planId);
  if (!plan || plan.goalId !== goalId)
    conflict();
  const { envelope, source } = loadSealedDraft(ctx, owner, plan);
  if (JSON.stringify(parsed) !== JSON.stringify(envelope.revision.payload.tasks))
    conflict();
  if (envelope.revision.taskMap.length || ctx.stores.tasks.list(owner, eq(t.tasks.planVersionId, planId)).length || envelope.revision.evidenceMap.length)
    conflict();
  const sourceKeys = new Set(source.map(task => task.id));
  const taskMap = parsed.map(task => ({
    draftKey: task.id, sourceTaskId: sourceKeys.has(task.id) ? task.id : null, storedTaskId: randomUUID()
  }));
  const storedIds = new Map(taskMap.map(item => [item.draftKey, item.storedTaskId]));
  const now = new Date().toISOString();
  const rows = parsed.map(task => ctx.stores.tasks.insert({
    ...task, id: storedIds.get(task.id)!, dependencyIds: task.dependencyIds.map(id => storedIds.get(id)!), ownerId: owner, goalId, planVersionId: planId, status: "todo", actualMinutes: null, createdAt: now, updatedAt: now, version: 1
  }));
  envelope.revision.taskMap = taskMap;
  ctx.stores.plans.update(owner, plan.id, plan.version, {
    diff: PlanRevisionEnvelopeSchema.parse(envelope)
  });
  return rows;
}
export function verifyStagedTasks(ctx: RepositoryContext, owner: string, plan: PlanVersion) {
  const sealed = loadSealedDraft(ctx, owner, plan);
  const { envelope, source } = sealed;
  const rows = ctx.stores.tasks.list(owner, eq(t.tasks.planVersionId, plan.id));
  const map = envelope.revision.taskMap;
  const proposed = envelope.revision.payload.tasks;
  if (map.length !== proposed.length || rows.length !== proposed.length || envelope.revision.evidenceMap.length || new Set(map.map(m => m.storedTaskId)).size !== map.length || new Set(map.map(m => m.draftKey)).size !== map.length)
    conflict();
  const sourceKeys = new Set(source.map(task => task.id));
  const ids = new Map(map.map(item => [item.draftKey, item.storedTaskId]));
  for (const [index, task] of proposed.entries()) {
    const entry = map[index];
    const row = rows.find(row => row.id === entry.storedTaskId);
    if (entry.draftKey !== task.id || entry.sourceTaskId !== (sourceKeys.has(task.id) ? task.id : null) || entry.storedTaskId === task.id || !row || row.goalId !== plan.goalId || row.status !== "todo" || row.actualMinutes !== null || row.version !== 1)
      conflict();
    const expected = {
      ...task, id: entry.storedTaskId, dependencyIds: task.dependencyIds.map(id => ids.get(id)!)
    };
    if (JSON.stringify(TaskCreateInputSchema.strip().parse(row)) !== JSON.stringify(expected))
      conflict();
    if (ctx.stores.evidence.list(owner, eq(t.taskEvidence.taskId, row.id)).length)
      conflict();
  }
  return {
    ...sealed, rows
  };
}
export function taskOperations(ctx: RepositoryContext): SyncRepository<TaskRepository> {
  return {
    createMany: (owner, goalId, planId, inputs) => materializeTasks(ctx, owner, goalId, planId, inputs),
    get: (owner, id) => ctx.stores.tasks.get(owner, id),
    listByGoal(owner, goalId, planId) {
      identity(owner, goalId);
      identity(owner, planId);
      return ctx.stores.tasks.list(owner, and(eq(t.tasks.goalId, goalId), eq(t.tasks.planVersionId, planId)));
    },
    update(owner, id, version, patch) {
      const value = TaskPatchSchema.parse(patch);
      const task = ctx.currentTask(owner, id);
      const updated = ctx.stores.tasks.update(owner, id, version, value);
      ctx.bumpGoal(owner, task.goalId);
      return updated;
    },
    delete(owner, id) {
      const task = ctx.currentTask(owner, id);
      const referenced = ctx.stores.tasks.list(owner, eq(t.tasks.planVersionId, task.planVersionId)).some(other => other.dependencyIds.includes(id)) || ctx.stores.evidence.list(owner, eq(t.taskEvidence.taskId, id)).length || ctx.stores.checkIns.list(owner, eq(t.checkIns.taskId, id)).length || ctx.stores.undos.list(owner, eq(t.undoRecords.taskId, id)).length;
      if (referenced || task.status !== "todo" || task.actualMinutes !== null)
        throw new AppError("INVALID_TRANSITION", 409, "Current task has execution or references; use a reviewed successor revision");
      ctx.stores.tasks.remove(owner, id);
      ctx.bumpGoal(owner, task.goalId);
    },
  };
}
