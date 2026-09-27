import { and, eq, gt, isNull, like, or, sql } from "drizzle-orm";
import { AppError } from "@/core/errors/app-error";
import { z } from "zod";
import * as t from "../db/schema";
import * as i from "./repository-inputs";
import { conflict, identity, type RepositoryContext } from "./repository-internals";
import type { SupportRepository, SyncRepository } from "./repository-types";
import { clearOwnerData, exportOwnerData } from "./support-data";
import { ModelUsageReceiptSchema, parseModelUsageReceipt } from "./model-usage-receipt";
export function supportOperations(ctx: RepositoryContext): SyncRepository<SupportRepository> {
  const s = ctx.stores;
  return {
    retainAccountModelUsage(owner, raw) {
      identity(owner); const receipt = ModelUsageReceiptSchema.parse(raw);
      const previous = ctx.db.select().from(t.accountModelUsage).where(and(eq(t.accountModelUsage.ownerId, owner), eq(t.accountModelUsage.attemptId, receipt.attemptId))).get();
      if (previous) {
        if (previous.day !== receipt.day || previous.inputTokens !== receipt.inputTokens || previous.outputTokens !== receipt.outputTokens)
          throw new AppError("VALIDATION_ERROR", 400, "Model attempt has different retained usage");
        return;
      }
      ctx.db.insert(t.accountModelUsage).values({ ownerId: owner, attemptId: receipt.attemptId, day: receipt.day, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens }).run();
    },
    listAccountModelUsage(owner, day) {
      identity(owner); z.iso.date().parse(day);
      return ctx.db.select().from(t.accountModelUsage).where(and(eq(t.accountModelUsage.ownerId, owner), eq(t.accountModelUsage.day, day))).all()
        .map(row => ModelUsageReceiptSchema.parse({ schemaVersion: 1, kind: "model_usage", attemptId: row.attemptId, day: row.day, inputTokens: row.inputTokens, outputTokens: row.outputTokens }));
    },
    consumeDailyAgentAdmission(owner, day, limit) {
      identity(owner); z.iso.date().parse(day); z.number().int().min(1).max(1000).parse(limit);
      const result = ctx.db.insert(t.agentDailyAdmissions).values({ ownerId: owner, day, count: 1 }).onConflictDoUpdate({
        target: [t.agentDailyAdmissions.ownerId, t.agentDailyAdmissions.day],
        set: { count: sql`${t.agentDailyAdmissions.count} + 1` },
        setWhere: sql`${t.agentDailyAdmissions.count} < ${limit}`,
      }).run();
      if (!result.changes) throw new AppError("MODEL_BUDGET_EXCEEDED", 429, "Daily new-turn limit reached");
    },
    listPendingDraftArtifacts(owner, goalId) {
      identity(owner, goalId);
      return s.drafts.list(owner, and(eq(t.draftArtifacts.goalId, goalId), eq(t.draftArtifacts.status, "pending")));
    },
    createCheckIn(owner, input) {
      const value = i.CheckInCreateInputSchema.parse(input);
      ctx.requireGoal(owner, value.goalId);
      if (value.taskId)
        ctx.currentTask(owner, value.taskId, value.goalId);
      const result = s.checkIns.create(owner, value);
      const ordinal = Math.max(0, ...s.undos.list(owner, eq(t.undoRecords.goalId, value.goalId)).map(row => row.ordinal)) + 1;
      s.undos.create(owner, { goalId: value.goalId, kind: "check_in", taskId: null, checkInId: result.id, ordinal, conversationFence: null, forwardPatch: { withdrawnAt: null }, reversePatch: { withdrawn: true }, undoneAt: null });
      ctx.bumpGoal(owner, value.goalId);
      return result;
    },
    getCheckIn: (owner, id) => s.checkIns.get(owner, id),
    withdrawCheckIn(owner, id, expectedVersion, withdrawnAt) {
      const old = s.checkIns.get(owner, id);
      if (!old || old.withdrawnAt !== null) conflict();
      ctx.requireGoal(owner, old.goalId);
      const result = s.checkIns.update(owner, id, expectedVersion, { withdrawnAt: z.iso.datetime({ offset: true }).parse(withdrawnAt) });
      ctx.bumpGoal(owner, old.goalId);
      return result;
    },
    listCheckInsByGoal(owner, goalId) {
      identity(owner, goalId);
      return s.checkIns.list(owner, eq(t.checkIns.goalId, goalId));
    },
    createTaskEvidence(owner, input) {
      const value = i.TaskEvidenceCreateInputSchema.parse(input);
      ctx.currentTask(owner, value.taskId, value.goalId);
      const result = s.evidence.create(owner, value);
      ctx.bumpGoal(owner, value.goalId);
      return result;
    },
    getTaskEvidence: (owner, id) => s.evidence.get(owner, id),
    listEvidenceByTask(owner, taskId) {
      identity(owner, taskId);
      return s.evidence.list(owner, eq(t.taskEvidence.taskId, taskId));
    },
    createAgentRun(owner, input) {
      const value = i.AgentRunCreateInputSchema.parse(input);
      ctx.requireGoal(owner, value.goalId);
      return s.runs.create(owner, value);
    },
    getAgentRun: (owner, id) => s.runs.get(owner, id),
    updateAgentRun: (owner, id, version, patch) => s.runs.update(owner, id, version, i.AgentRunPatchSchema.parse(patch)),
    createApprovalGrant: (owner, input) => s.grants.create(owner, {
      ...i.ApprovalGrantCreateInputSchema.parse(input), usedAt: null
    }),
    getApprovalGrant: (owner, id) => s.grants.get(owner, id),
    consumeApprovalGrant(owner, input) {
      identity(owner);
      const value = i.ConsumeApprovalGrantInputSchema.parse(input);
      const now = Date.parse(value.now);
      // One conditional write, not read-then-unconditionally-set consumption.
      const result = ctx.db.update(t.approvalGrants).set({
        usedAt: now, updatedAt: now, version: value.expectedVersion + 1
      }).where(and(eq(t.approvalGrants.ownerId, owner), eq(t.approvalGrants.id, value.grantId), eq(t.approvalGrants.subjectId, value.subjectId), eq(t.approvalGrants.allowedTool, value.allowedTool), eq(t.approvalGrants.contentHash, value.contentHash), isNull(t.approvalGrants.usedAt), eq(t.approvalGrants.version, value.expectedVersion), gt(t.approvalGrants.expiresAt, now))).run();
      return result.changes === 1 ? s.grants.get(owner, value.grantId) : null;
    },
    createOperation(owner, input) {
      const value = i.OperationCreateInputSchema.parse(input);
      if (value.goalId)
        ctx.requireGoal(owner, value.goalId);
      return s.operations.create(owner, {
        ...value, status: "pending", result: null
      });
    },
    getOperation: (owner, id) => s.operations.get(owner, id),
    getOperationByOperationId(owner, operationId) {
      z.string().trim().min(1).parse(operationId);
      return s.operations.list(owner, eq(t.operations.operationId, operationId))[0] ?? null;
    },
    listSucceededAgentTurnOperations(owner, goalId) {
      identity(owner, goalId);
      return s.operations.list(owner, and(
        eq(t.operations.goalId, goalId),
        eq(t.operations.toolName, "agent_turn"),
        eq(t.operations.status, "succeeded"),
      ));
    },
    listModelUsageReceipts(owner, day) {
      identity(owner);
      z.iso.date().parse(day);
      return s.operations.list(owner, or(eq(t.operations.toolName, "record_model_usage"), like(t.operations.operationId, "model-usage:%")))
        .map(parseModelUsageReceipt).filter(receipt => receipt.day === day);
    },
    updateOperation: (owner, id, version, patch) => s.operations.update(owner, id, version, i.OperationPatchSchema.parse(patch)),
    createUndoRecord(owner, input) {
      const value = i.UndoRecordCreateInputSchema.parse(input);
      ctx.requireGoal(owner, value.goalId);
      if (value.kind === "task_execution") {
        if (!value.taskId || value.checkInId !== null) conflict();
        ctx.currentTask(owner, value.taskId, value.goalId);
      } else {
        const checkIn = value.checkInId ? s.checkIns.get(owner, value.checkInId) : null;
        if (value.taskId !== null || !checkIn || checkIn.goalId !== value.goalId || checkIn.withdrawnAt !== null) conflict();
      }
      const ordinal = Math.max(0, ...s.undos.list(owner, eq(t.undoRecords.goalId, value.goalId)).map(row => row.ordinal)) + 1;
      return s.undos.create(owner, {
        ...value, ordinal, conversationFence: null, undoneAt: null
      });
    },
    getUndoRecord: (owner, id) => s.undos.get(owner, id),
    listUndoRecordsByGoal(owner, goalId) {
      identity(owner, goalId);
      return s.undos.list(owner, eq(t.undoRecords.goalId, goalId)).sort((a, b) => a.ordinal - b.ordinal);
    },
    getLatestPendingUndo(owner, goalId) {
      identity(owner, goalId);
      return s.undos.list(owner, and(eq(t.undoRecords.goalId, goalId), isNull(t.undoRecords.undoneAt))).sort((a, b) => a.ordinal - b.ordinal).at(-1) ?? null;
    },
    updateUndoRecord(owner, id, version, patch) {
      const value = i.UndoRecordPatchSchema.parse(patch);
      const old = s.undos.get(owner, id);
      if (!old || old.undoneAt !== null)
        conflict();
      if (old.kind === "task_execution") {
        if (!old.taskId || value.conversationFence) conflict();
        ctx.currentTask(owner, old.taskId, old.goalId);
      } else {
        const checkIn = old.checkInId ? s.checkIns.get(owner, old.checkInId) : null;
        if (!checkIn || checkIn.goalId !== old.goalId || !checkIn.withdrawnAt) conflict();
        const fence = value.conversationFence;
        const lastMessageId = s.messages.list(owner, eq(t.conversationMessages.goalId, old.goalId)).at(-1)?.id ?? null;
        const lastTurnId = s.operations.list(owner, and(eq(t.operations.goalId, old.goalId), eq(t.operations.toolName, "agent_turn"), eq(t.operations.status, "succeeded"))).at(-1)?.id ?? null;
        const revision = Math.max(0, ...s.undos.list(owner, eq(t.undoRecords.goalId, old.goalId)).map(row => row.conversationFence?.revision ?? 0)) + 1;
        if (!fence || fence.revision !== revision || fence.throughMessageId !== lastMessageId || fence.throughAgentTurnOperationId !== lastTurnId || value.undoneAt !== checkIn.withdrawnAt) conflict();
      }
      return s.undos.update(owner, id, version, value);
    },
    createUserPreference(owner, input) {
      const value = i.UserPreferenceCreateInputSchema.parse(input);
      if (s.preferences.list(owner).length)
        conflict();
      return s.preferences.create(owner, value);
    },
    getUserPreference: (owner, id) => s.preferences.get(owner, id),
    getPreferencesByOwner: owner => s.preferences.list(owner)[0] ?? null,
    updateUserPreference: (owner, id, version, patch) => s.preferences.update(owner, id, version, i.UserPreferencePatchSchema.parse(patch)),
    createAuditEvent(owner, input) {
      const value = i.AuditEventCreateInputSchema.parse(input);
      if (value.goalId)
        ctx.requireGoal(owner, value.goalId);
      return s.audits.create(owner, value);
    },
    getAuditEvent: (owner, id) => s.audits.get(owner, id),
    listAuditEventsByGoal(owner, goalId) {
      identity(owner, goalId);
      return s.audits.list(owner, eq(t.auditEvents.goalId, goalId));
    },
    createAppSetting(owner, input) {
      const value = i.AppSettingCreateInputSchema.parse(input);
      if (s.settings.list(owner).length)
        conflict();
      return s.settings.create(owner, value);
    },
    getAppSetting: (owner, id) => s.settings.get(owner, id),
    getSettingsByOwner: owner => s.settings.list(owner)[0] ?? null,
    updateAppSetting: (owner, id, version, patch) => s.settings.update(owner, id, version, i.AppSettingPatchSchema.parse(patch)),
    exportOwnerData: owner => exportOwnerData(ctx, owner),
    clearOwnerData: (owner, retainedOperationId) => clearOwnerData(ctx, owner, retainedOperationId),
  };
}
