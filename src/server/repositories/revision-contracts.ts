import { z } from "zod";
import type { Task } from "@/core/domain/contracts";
import {
  type ExecutionReset,
  type PlanRevisionPayload,
  type TaskCreateInput,
} from "@/lib/public-api-schemas";
const uuid = z.string().uuid();
export {
  ExecutionResetSchema,
  PlanDiffSchema,
  PlanMilestonesSchema,
  PlanRevisionEnvelopeSchema,
  PlanRevisionPayloadSchema,
  TaskCreateInputSchema,
  type ExecutionReset,
  type PlanMilestones,
  type PlanRevisionEnvelope,
  type PlanRevisionPayload,
  type TaskCreateInput,
} from "@/lib/public-api-schemas";
export const PlanVersionCreateInputSchema = z.object({
  draftArtifactId: uuid, expectedDraftArtifactVersion: z.number().int().positive()
}).strict();
export type PlanVersionCreateInput = z.infer<typeof PlanVersionCreateInputSchema>;
/** Pure canonical completion-meaning rule shared by review preparation and approval. */
export function deriveExecutionResets(sourceTasks: readonly Task[], proposedTasks: readonly TaskCreateInput[]): ExecutionReset[] {
  const source = new Map(sourceTasks.map(t => [t.id, t]));
  const reasons = new Map<string, ExecutionReset["reason"]>();
  for (const next of proposedTasks) {
    const old = source.get(next.id);
    if (old && (old.action !== next.action || old.doneCriteria !== next.doneCriteria || old.evidenceType !== next.evidenceType || JSON.stringify([...old.dependencyIds].sort()) !== JSON.stringify([...next.dependencyIds].sort())))
      reasons.set(next.id, "completion_meaning_changed");
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const next of proposedTasks)
      if (source.has(next.id) && !reasons.has(next.id) && next.dependencyIds.some(id => reasons.has(id))) {
        reasons.set(next.id, "prerequisite_reset");
        changed = true;
      }
  }
  return proposedTasks.flatMap(t => reasons.has(t.id) ? [{
      taskKey: t.id, reason: reasons.get(t.id)!
    }] : []);
}
export function verifyExecutionResets(sourceTasks: readonly Task[], payload: PlanRevisionPayload): boolean {
  return JSON.stringify(deriveExecutionResets(sourceTasks, payload.tasks)) === JSON.stringify(payload.executionResets);
}
