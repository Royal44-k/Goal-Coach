import { derivePreferenceSignals } from "@/core/planning/adaptation";
import type { TransactionRepositories } from "../repositories/repository-types";
import { planningProjection } from "./workspace-projection";
import { ensurePreferences } from "./settings-service";
import { reconcileReviewState } from "./review-state";
export function reconcileTaskSignals(tx: TransactionRepositories, owner: string, goalId: string) {
  const p = planningProjection(tx, owner, goalId);
  const preference = ensurePreferences(tx, owner);
  const signals = derivePreferenceSignals(p.tasks, p.projectedCheckIns);
  tx.support.updateUserPreference(owner, preference.id, preference.version, { estimateBias: signals.estimateBias ?? 1, taskGranularity: signals.taskGranularity ?? "medium", commonBlockers: signals.commonBlockers });
  reconcileReviewState(tx, owner, goalId);
}
