import { GOAL_REVIEW_REQUEST_MESSAGE } from "@/lib/public-api-schemas";
import { TurnRecordSchema } from "../agent/agent-turn-store";
import type { TransactionRepositories } from "../repositories/repository-types";
import { contentHash } from "../security/canonical-json";

/** Historical success is valid; conversation tails and uncorrelated operations are not. */
export function savedReflection(tx: TransactionRepositories, owner: string, goalId: string) {
  const reviewHash = contentHash({ goalId, userMessage: GOAL_REVIEW_REQUEST_MESSAGE, explicitIntent: true });
  const latestFence = tx.support.listUndoRecordsByGoal(owner, goalId).flatMap(row => row.conversationFence ? [row.conversationFence] : []).sort((a, b) => a.revision - b.revision).at(-1);
  const operations = tx.support.listSucceededAgentTurnOperations(owner, goalId);
  const boundary = latestFence?.throughAgentTurnOperationId ? operations.findIndex(operation => operation.id === latestFence.throughAgentTurnOperationId) : -1;
  return operations.reduce<null | { message: string; generatedAt: string; stale: boolean }>((latest, operation, index) => {
    if (operation.ownerId !== owner || operation.goalId !== goalId || operation.toolName !== "agent_turn"
      || operation.status !== "succeeded" || operation.parameterHash !== reviewHash) return latest;
    const parsed = TurnRecordSchema.safeParse(operation.result);
    if (!parsed.success || parsed.data.phase !== "done" || !parsed.data.outcome.ok) return latest;
    const message = parsed.data.outcome.data.message;
    return { message, generatedAt: operation.updatedAt, stale: latestFence !== undefined && (index <= boundary || (!!latestFence.throughAgentTurnOperationId && boundary < 0)) };
  }, null);
}
