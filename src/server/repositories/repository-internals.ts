import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import * as d from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type { AppDatabase } from "../db/client";
import * as tables from "../db/schema";
export type Executor = Omit<AppDatabase, "$client">;
type Table = Extract<(typeof tables)[keyof typeof tables], { ownerId: unknown; id: unknown; version: unknown }>;
type Entity = {
  id: string;
  ownerId: string;
  version: number;
  createdAt: string;
  updatedAt?: string;
};
const timestamps = new Set(["createdAt", "updatedAt", "approvedAt", "expiresAt", "usedAt", "undoneAt", "withdrawnAt", "privacyAcceptedAt"]);
export function conflict(): never {
  throw new AppError("VERSION_CONFLICT", 409, "Repository version or snapshot conflict");
}
export function invalid(): never {
  throw new AppError("VALIDATION_ERROR", 400, "Invalid repository input");
}
export function identity(ownerId: string, id?: string) {
  z.string().uuid().parse(ownerId);
  if (id !== undefined)
    z.string().uuid().parse(id);
}
function decode(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, timestamps.has(key) && typeof value === "number" ? new Date(value).toISOString() : value]));
}
function encode(row: object) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, timestamps.has(key) && typeof value === "string" ? Date.parse(value) : value]));
}
/** Private Drizzle bridge: schema parsing precedes writes and follows every read. */
function store<E extends Entity>(db: Executor, table: Table, schema: z.ZodType<E>) {
  const scope = (ownerId: string, id?: string) => {
    identity(ownerId, id);
    return and(eq(table.ownerId, ownerId), id === undefined ? undefined : eq(table.id, id));
  };
  const parse = (row: Record<string, unknown>) => schema.parse(decode(row));
  return {
    get(ownerId: string, id: string): E | null {
      const row = db.select().from(table).where(scope(ownerId, id)).get();
      return row ? parse(row) : null;
    },
    list(ownerId: string, filter?: SQL): E[] {
      return db.select().from(table).where(and(scope(ownerId), filter)).orderBy(sql `rowid`).all().map(parse);
    },
    insert(entity: E): E {
      const value = schema.parse(entity);
      db.insert(table).values(encode(value) as never).run();
      return value;
    },
    create(ownerId: string, input: object): E {
      identity(ownerId);
      const now = new Date().toISOString();
      const entity = schema.parse({
        ...input, id: randomUUID(), ownerId, createdAt: now, updatedAt: now, version: 1
      });
      // Union tables have different insert overloads; the paired entity schema validates the private bridge.
      db.insert(table).values(encode(entity) as never).run();
      return entity;
    },
    update(ownerId: string, id: string, version: number, patch: object): E {
      z.number().int().positive().parse(version);
      const old = this.get(ownerId, id);
      if (!old || old.version !== version)
        conflict();
      const entity = schema.parse({
        ...old, ...patch, id, ownerId, createdAt: old.createdAt, updatedAt: new Date().toISOString(), version: version + 1
      });
      const changed = db.update(table).set(encode(entity) as never).where(and(scope(ownerId, id), eq(table.version, version))).run().changes;
      if (changed !== 1)
        conflict();
      return entity;
    },
    remove(ownerId: string, id: string) {
      db.delete(table).where(scope(ownerId, id)).run();
    },
  };
}
export function createContext(db: Executor) {
  const stores = {
    goals: store(db, tables.goals, d.GoalSchema), tasks: store(db, tables.tasks, d.TaskSchema), plans: store(db, tables.planVersions, d.PlanVersionSchema), drafts: store(db, tables.draftArtifacts, d.DraftArtifactSchema),
    checkIns: store(db, tables.checkIns, d.CheckInSchema), evidence: store(db, tables.taskEvidence, d.TaskEvidenceSchema), runs: store(db, tables.agentRuns, d.AgentRunSchema), grants: store(db, tables.approvalGrants, d.ApprovalGrantSchema), operations: store(db, tables.operations, d.OperationSchema), undos: store(db, tables.undoRecords, d.UndoRecordSchema),
    messages: store(db, tables.conversationMessages, d.ConversationMessageSchema), summaries: store(db, tables.conversationSummaries, d.ConversationSummarySchema), preferences: store(db, tables.userPreferences, d.UserPreferenceSchema), audits: store(db, tables.auditEvents, d.AuditEventSchema), settings: store(db, tables.appSettings, d.AppSettingSchema),
  };
  const requireGoal = (owner: string, goalId: string) => {
    const goal = stores.goals.get(owner, goalId);
    if (!goal)
      conflict();
    return goal;
  };
  const currentTask = (owner: string, taskId: string, goalId?: string) => {
    const task = stores.tasks.get(owner, taskId);
    if (!task || (goalId !== undefined && task.goalId !== goalId))
      conflict();
    const goal = requireGoal(owner, task.goalId);
    const plan = stores.plans.get(owner, task.planVersionId);
    if (!plan || plan.goalId !== goal.id || plan.status !== "approved" || goal.currentPlanVersionId !== plan.id)
      conflict();
    return task;
  };
  const bumpGoal = (owner: string, goalId: string) => {
    const goal = requireGoal(owner, goalId);
    stores.goals.update(owner, goal.id, goal.version, {});
  };
  return {
    db, stores, requireGoal, currentTask, bumpGoal
  };
}
export type RepositoryContext = ReturnType<typeof createContext>;
