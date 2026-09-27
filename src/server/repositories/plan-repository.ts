import { eq } from "drizzle-orm";
import * as t from "../db/schema";
import { DraftArtifactCreateInputSchema, DraftArtifactPatchSchema } from "./repository-inputs";
import { conflict, identity, type RepositoryContext } from "./repository-internals";
import { PlanRevisionEnvelopeSchema, PlanRevisionPayloadSchema, PlanVersionCreateInputSchema } from "./revision-contracts";
import type { PlanRepository, SyncRepository } from "./repository-types";
import { loadSealedDraft, materializeTasks, validateSnapshot, verifyStagedTasks } from "./task-repository";
export function planOperations(ctx: RepositoryContext): SyncRepository<PlanRepository> {
  const s = ctx.stores;
  return {
    saveDraftArtifact(owner, input) {
      const value = DraftArtifactCreateInputSchema.parse(input);
      ctx.requireGoal(owner, value.goalId);
      if (value.kind === "plan" || value.kind === "replan") {
        const payload = PlanRevisionPayloadSchema.parse(value.payload);
        validateSnapshot(ctx, owner, value.goalId, payload);
        if ((value.kind === "plan") !== (payload.base.planVersionId === null))
          conflict();
        value.payload = payload;
      }
      return s.drafts.create(owner, {
        ...value, status: "pending"
      });
    },
    getDraftArtifact: (owner, id) => s.drafts.get(owner, id),
    updateDraftArtifact(owner, id, version, patch) {
      const value = DraftArtifactPatchSchema.parse(patch);
      const old = s.drafts.get(owner, id);
      if (!old || old.status !== "pending" || value.status === "pending")
        conflict();
      return s.drafts.update(owner, id, version, value);
    },
    createDraft(owner, goalId, input) {
      const value = PlanVersionCreateInputSchema.parse(input);
      const artifact = s.drafts.get(owner, value.draftArtifactId);
      if (!artifact || artifact.goalId !== goalId || artifact.status !== "pending" || artifact.version !== value.expectedDraftArtifactVersion || (artifact.kind !== "plan" && artifact.kind !== "replan"))
        conflict();
      const payload = PlanRevisionPayloadSchema.parse(artifact.payload);
      validateSnapshot(ctx, owner, goalId, payload);
      const versions = s.plans.list(owner, eq(t.planVersions.goalId, goalId));
      if (versions.some(plan => PlanRevisionEnvelopeSchema.parse(plan.diff).revision.draftArtifactId === artifact.id))
        conflict();
      const diff = PlanRevisionEnvelopeSchema.parse({
        ...payload.diff, revision: {
          schemaVersion: 2, draftArtifactId: artifact.id, draftArtifactVersion: artifact.version, payload, taskMap: [], evidenceMap: []
        }
      });
      return s.plans.create(owner, {
        goalId, number: Math.max(0, ...versions.map(plan => plan.number)) + 1, status: "draft", changeReason: payload.changeReason, changeSource: payload.changeSource, diff, approvedAt: null
      });
    },
    approve(owner, planId, expectedVersion) {
      let plan = s.plans.get(owner, planId);
      if (!plan || plan.version !== expectedVersion)
        conflict();
      const { envelope: initial } = loadSealedDraft(ctx, owner, plan);
      if (!initial.revision.taskMap.length && !s.tasks.list(owner, eq(t.tasks.planVersionId, planId)).length) {
        materializeTasks(ctx, owner, plan.goalId, plan.id, initial.revision.payload.tasks);
        plan = s.plans.get(owner, planId)!;
      }
      const { envelope, source } = verifyStagedTasks(ctx, owner, plan);
      const sourceById = new Map(source.map(task => [task.id, task]));
      const resetKeys = new Set(envelope.revision.payload.executionResets.map(reset => reset.taskKey));
      for (const mapping of envelope.revision.taskMap) {
        const previous = mapping.sourceTaskId ? sourceById.get(mapping.sourceTaskId) : undefined;
        if (!previous || resetKeys.has(mapping.draftKey))
          continue;
        const row = s.tasks.get(owner, mapping.storedTaskId)!;
        s.tasks.update(owner, row.id, row.version, {
          status: previous.status, actualMinutes: previous.actualMinutes
        });
        for (const evidence of s.evidence.list(owner, eq(t.taskEvidence.taskId, previous.id))) {
          if (evidence.goalId !== plan.goalId)
            conflict();
          const copy = s.evidence.create(owner, {
            goalId: plan.goalId, taskId: row.id, type: evidence.type, text: evidence.text, fileName: evidence.fileName, fileSize: evidence.fileSize, mimeType: evidence.mimeType
          });
          envelope.revision.evidenceMap.push({
            sourceEvidenceId: evidence.id, copiedEvidenceId: copy.id
          });
        }
      }
      const goal = ctx.requireGoal(owner, plan.goalId);
      if (goal.currentPlanVersionId) {
        const previous = s.plans.get(owner, goal.currentPlanVersionId);
        if (!previous || previous.status !== "approved")
          conflict();
        s.plans.update(owner, previous.id, previous.version, {
          status: "superseded"
        });
      }
      const approved = s.plans.update(owner, plan.id, plan.version, {
        status: "approved", approvedAt: new Date().toISOString(), diff: PlanRevisionEnvelopeSchema.parse(envelope)
      });
      s.goals.update(owner, goal.id, goal.version, {
        currentPlanVersionId: plan.id, status: "active", agentState: "active"
      });
      return approved;
    },
    getCurrent(owner, goalId) {
      const goal = s.goals.get(owner, goalId);
      if (!goal?.currentPlanVersionId)
        return null;
      const plan = s.plans.get(owner, goal.currentPlanVersionId);
      if (!plan || plan.goalId !== goalId || plan.status !== "approved")
        conflict();
      return plan;
    },
    listVersions(owner, goalId) {
      identity(owner, goalId);
      return s.plans.list(owner, eq(t.planVersions.goalId, goalId));
    },
  };
}
