import { and, eq, ne } from "drizzle-orm";
import * as t from "../db/schema";
import { conflict, identity, type RepositoryContext } from "./repository-internals";
import type { OwnerExportData } from "./repository-types";
const goalChildren = [t.taskEvidence, t.undoRecords, t.checkIns, t.conversationSummaries, t.conversationMessages, t.agentRuns, t.auditEvents, t.operations, t.draftArtifacts, t.tasks, t.planVersions] as const;
export function deleteGoalData(ctx: RepositoryContext, owner: string, goalId: string) {
  const goal = ctx.stores.goals.get(owner, goalId);
  if (!goal)
    return;
  // Grants have polymorphic subjects; remove those bound to the goal or its children.
  const subjects = new Set([goalId, ...ctx.stores.tasks.list(owner, eq(t.tasks.goalId, goalId)).map(r => r.id), ...ctx.stores.drafts.list(owner, eq(t.draftArtifacts.goalId, goalId)).map(r => r.id)]);
  for (const grant of ctx.stores.grants.list(owner))
    if (subjects.has(grant.subjectId))
      ctx.stores.grants.remove(owner, grant.id);
  ctx.stores.goals.update(owner, goal.id, goal.version, {
    currentPlanVersionId: null
  });
  for (const table of goalChildren)
    ctx.db.delete(table).where(and(eq(table.ownerId, owner), eq(table.goalId, goalId))).run();
  ctx.stores.goals.remove(owner, goalId);
}
export function exportOwnerData(ctx: RepositoryContext, owner: string): OwnerExportData {
  identity(owner);
  const s = ctx.stores;
  return {
    goals: s.goals.list(owner), tasks: s.tasks.list(owner), planVersions: s.plans.list(owner), checkIns: s.checkIns.list(owner), evidence: s.evidence.list(owner), preferences: s.preferences.list(owner), conversationSummaries: s.summaries.list(owner), conversationMessages: s.messages.list(owner)
  };
}
export function clearOwnerData(ctx: RepositoryContext, owner: string, retainedOperationId: string): Record<string, number> {
  const operation = ctx.stores.operations.get(owner, retainedOperationId);
  if (!operation || operation.goalId !== null || operation.toolName !== "clear_all_data" || operation.status !== "pending" || operation.result !== null)
    conflict();
  const counts: Record<string, number> = {};
  for (const goal of ctx.stores.goals.list(owner))
    ctx.stores.goals.update(owner, goal.id, goal.version, {
      currentPlanVersionId: null
    });
  const ordered = {
    evidence: t.taskEvidence, undoRecords: t.undoRecords, checkIns: t.checkIns, conversationSummaries: t.conversationSummaries, conversationMessages: t.conversationMessages, agentRuns: t.agentRuns, auditEvents: t.auditEvents, draftArtifacts: t.draftArtifacts, tasks: t.tasks, planVersions: t.planVersions, operations: t.operations, goals: t.goals, approvalGrants: t.approvalGrants, preferences: t.userPreferences, settings: t.appSettings
  };
  for (const [name, table] of Object.entries(ordered))
    counts[name] = ctx.db.delete(table).where(and(eq(table.ownerId, owner), name === "operations" ? ne(table.id, retainedOperationId) : undefined)).run().changes;
  return counts;
}
