import { z } from "zod";
import { GoalSchema, JsonObjectSchema, type AgentRun, type AppSetting, type Goal, type Operation } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import { AgentTurnResultSchema, type AgentTurnResult } from "@/lib/public-api-schemas";
import { canTransition, recoverState, transition } from "@/core/state-machine/agent-state-machine";
import type { Repositories, RepositoryUnitOfWork, TransactionRepositories } from "../repositories/repository-types";
import { contentHash } from "../security/canonical-json";
import { QWEN_PRIMARY_MODEL } from "../config/env";
import { AgentTurnError, AgentTurnFailureSchema, toAgentTurnError } from "./agent-turn-error";
import type { GoalCheckpoint } from "./domain-write-observer";
import { reconcileReviewState } from "../services/review-state";
import { agentAdmissionDay } from "./admission-limits";

export const ProcessTurnInputSchema = z.object({
  ownerId: z.string().trim().uuid(), goalId: z.string().trim().uuid(),
  userMessage: z.string().trim().min(1), explicitIntent: z.boolean(), requestOperationId: z.string().trim().uuid(),
}).strict();
export type ProcessTurnInput = z.infer<typeof ProcessTurnInputSchema>;
export { AgentTurnResultSchema, type AgentTurnResult } from "@/lib/public-api-schemas";
export const TurnRecordSchema = z.discriminatedUnion("phase", [
  z.object({ schemaVersion: z.literal(1), kind: z.literal("agent_turn"), phase: z.literal("running"), runId: z.uuid() }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal("agent_turn"), phase: z.literal("done"), outcome: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: AgentTurnResultSchema }).strict(),
    z.object({ ok: z.literal(false), failure: AgentTurnFailureSchema }).strict(),
  ]) }).strict(),
]);
export type AdmittedTurn = {
  input: ProcessTurnInput; operationEntityId: string; runId: string; settingId: string | null; initialGoal: Goal;
};
export type TurnAdmission = { kind: "admitted"; turn: AdmittedTurn } | { kind: "replay"; result: AgentTurnResult };
function invalid(): never { throw new AppError("VALIDATION_ERROR", 400, "Invalid agent turn record or binding"); }
function record(operation: Operation) {
  const parsed = TurnRecordSchema.safeParse(operation.result);
  if (!parsed.success) return invalid();
  const value = parsed.data;
  if (value.phase === "running" ? operation.status !== "pending" : operation.status !== (value.outcome.ok ? "succeeded" : "failed")) invalid();
  return value;
}
export function ownsGoal(checkpoint: GoalCheckpoint | null, goal: GoalCheckpoint | null): boolean {
  return checkpoint !== null && goal !== null && checkpoint.id === goal.id && checkpoint.version === goal.version
    && checkpoint.agentState === goal.agentState && checkpoint.status === goal.status && checkpoint.currentPlanVersionId === goal.currentPlanVersionId;
}
type FinalCounters = { toolCalls: number; latencyMs: number };
export type TurnLiveness =
  | { status: "live"; current: { goal: Goal; run: AgentRun; operation: Operation; setting: AppSetting | null } }
  | { status: "cancelled"; reason: "workspace_cleared" | "turn_deleted" };

/** Persistence for a single bounded turn; no provider I/O or resumable workflow. */
export class AgentTurnStore {
  constructor(private readonly repositories: Repositories & RepositoryUnitOfWork, private readonly admission?: { dailyLimit: number; now: () => Date }, private readonly model = QWEN_PRIMARY_MODEL) {}

  async admit(raw: ProcessTurnInput): Promise<TurnAdmission> {
    const parsed = ProcessTurnInputSchema.safeParse(raw);
    if (!parsed.success) invalid();
    const input = parsed.data;
    const { ownerId, goalId, userMessage, explicitIntent, requestOperationId } = input;
    const operationId = `agent-turn:${requestOperationId}`;
    const parameterHash = contentHash({ goalId, userMessage, explicitIntent });
    return this.repositories.withTransaction<TurnAdmission>(tx => {
      const existing = tx.support.getOperationByOperationId(ownerId, operationId);
      if (existing) {
        if (existing.toolName !== "agent_turn" || existing.goalId !== goalId || existing.parameterHash !== parameterHash) invalid();
        const stored = record(existing);
        if (stored.phase === "running") throw new AppError("INVALID_TRANSITION", 409, "Agent turn is pending; refresh current state");
        if (!stored.outcome.ok) throw new AgentTurnError(stored.outcome.failure);
        return { kind: "replay", result: stored.outcome.data };
      }
      const goal = tx.goals.get(ownerId, goalId);
      if (!goal) throw new AppError("NOT_FOUND", 404, "Goal is unavailable");
      if (goal.status === "completed" || goal.status === "archived" || goal.agentState === "completed" || goal.agentState === "failed_recoverable")
        throw new AppError("INVALID_TRANSITION", 409, "Goal cannot admit another agent turn");
      if (this.admission) tx.support.consumeDailyAgentAdmission(ownerId, agentAdmissionDay(this.admission.now()), this.admission.dailyLimit);
      const operation = tx.support.createOperation(ownerId, { goalId, operationId, toolName: "agent_turn", parameterHash });
      const run = tx.support.createAgentRun(ownerId, { goalId, startState: goal.agentState, endState: null, status: "running", model: this.model, inputTokenCount: 0, outputTokenCount: 0, toolCallCount: 0, latencyMs: 0, errorCode: null });
      tx.support.updateOperation(ownerId, operation.id, operation.version, { result: { schemaVersion: 1, kind: "agent_turn", phase: "running", runId: run.id } });
      tx.conversations.append(ownerId, goalId, { role: "user", content: userMessage });
      return { kind: "admitted", turn: { input, initialGoal: goal, operationEntityId: operation.id, runId: run.id, settingId: tx.support.getSettingsByOwner(ownerId)?.id ?? null } };
    });
  }

  current(turn: AdmittedTurn, expectedFenceRevision?: number) {
    return this.repositories.withTransaction(tx => {
      const current = this.live(tx, turn);
      if (expectedFenceRevision !== undefined && tx.conversations.getSnapshot(turn.input.ownerId, turn.input.goalId).fenceRevision !== expectedFenceRevision)
        throw new AppError("VERSION_CONFLICT", 409, "Agent context was withdrawn");
      return current;
    });
  }

  /** A returned cancellation is verified; a thrown read error proves no cancellation. */
  checkCurrent(turn: AdmittedTurn): Promise<TurnLiveness> {
    return this.repositories.withTransaction(tx => this.inspect(tx, turn));
  }

  /** Commit all final success surfaces against one owned Goal/generation snapshot. */
  async succeed(turn: AdmittedTurn, owned: GoalCheckpoint | null, result: AgentTurnResult, proposedClarificationCount: number, counters: FinalCounters): Promise<AgentTurnResult> {
    return this.repositories.withTransaction(tx => {
      const data = AgentTurnResultSchema.parse(result);
      const clarificationCount = GoalSchema.shape.clarificationCount.parse(proposedClarificationCount);
      const { goal, run, operation } = this.live(tx, turn);
      if (!ownsGoal(owned, goal)) throw new AppError("VERSION_CONFLICT", 409, "Goal changed while composing reply");
      if (data.state !== goal.agentState || clarificationCount !== goal.clarificationCount) {
        transition(goal.agentState, data.state);
        tx.goals.update(turn.input.ownerId, goal.id, goal.version, { agentState: data.state, clarificationCount });
      }
      const finalGoal = reconcileReviewState(tx, turn.input.ownerId, goal.id);
      data.state = finalGoal.agentState;
      // Stamp only newly committed advice. Exact historical replay remains untouched.
      if (data.advice) data.adviceGoalVersion = finalGoal.version;
      tx.conversations.append(turn.input.ownerId, goal.id, { role: "assistant", content: data.message });
      tx.support.updateAgentRun(turn.input.ownerId, run.id, run.version, { status: "succeeded", endState: data.state, toolCallCount: counters.toolCalls, latencyMs: counters.latencyMs });
      tx.support.updateOperation(turn.input.ownerId, operation.id, operation.version, { status: "succeeded", result: JsonObjectSchema.parse(TurnRecordSchema.parse({ schemaVersion: 1, kind: "agent_turn", phase: "done", outcome: { ok: true, data } })) });
      return data;
    });
  }

  async fail(turn: AdmittedTurn, original: unknown, owned: GoalCheckpoint | null, persistedChange: boolean, counters: FinalCounters): Promise<AgentTurnError> {
    const finalize = (recover: boolean) => this.repositories.withTransaction(tx => {
      let goal = tx.goals.get(turn.input.ownerId, turn.input.goalId);
      // A generation change or deleted data is never a license to recreate rows.
      const generationMatches = (tx.support.getSettingsByOwner(turn.input.ownerId)?.id ?? null) === turn.settingId;
      const run = tx.support.getAgentRun(turn.input.ownerId, turn.runId);
      const operation = tx.support.getOperation(turn.input.ownerId, turn.operationEntityId);
      if (generationMatches && goal && run && operation) {
        if (recover && ownsGoal(owned, goal) && canTransition(goal.agentState, "failed_recoverable")) {
          const safe = recoverState(goal.agentState);
          transition("failed_recoverable", safe);
          const failed = tx.goals.update(turn.input.ownerId, goal.id, goal.version, { agentState: "failed_recoverable" });
          goal = tx.goals.update(turn.input.ownerId, goal.id, failed.version, { agentState: safe });
          goal = reconcileReviewState(tx, turn.input.ownerId, goal.id);
        }
        const error = toAgentTurnError(original, { state: goal.agentState, persistedChange });
        const stored = record(operation);
        if (stored.phase !== "running" || stored.runId !== run.id) invalid();
        tx.support.updateAgentRun(turn.input.ownerId, run.id, run.version, { status: "failed", endState: goal.agentState, toolCallCount: counters.toolCalls, latencyMs: counters.latencyMs, errorCode: error.code });
        const failure = AgentTurnFailureSchema.parse({ code: error.code, status: error.status, ...error.turn });
        tx.support.updateOperation(turn.input.ownerId, operation.id, operation.version, { status: "failed", result: JsonObjectSchema.parse(TurnRecordSchema.parse({ schemaVersion: 1, kind: "agent_turn", phase: "done", outcome: { ok: false, failure } })) });
        return error;
      }
      return toAgentTurnError(original, { state: goal?.agentState ?? null, persistedChange });
    });
    try { return await finalize(true); }
    catch {
      // Roll back a failed transition pair before trying finalization alone.
      try { return await finalize(false); }
      catch {
        // The claim may still be pending. Preserve the original safe error.
        let goal: Goal | null = null;
        try { goal = await this.repositories.goals.get(turn.input.ownerId, turn.input.goalId); } catch { /* unavailable */ }
        return toAgentTurnError(original, { state: goal?.agentState ?? null, persistedChange });
      }
    }
  }

  private live(tx: TransactionRepositories, turn: AdmittedTurn) {
    const checked = this.inspect(tx, turn);
    if (checked.status === "cancelled") {
      if (checked.reason === "workspace_cleared") throw new AppError("VERSION_CONFLICT", 409, "Workspace generation changed");
      throw new AppError("NOT_FOUND", 404, "Agent turn data was deleted");
    }
    return checked.current;
  }

  private inspect(tx: TransactionRepositories, turn: AdmittedTurn): TurnLiveness {
    const { ownerId, goalId } = turn.input;
    const setting = tx.support.getSettingsByOwner(ownerId);
    if ((setting?.id ?? null) !== turn.settingId) return { status: "cancelled", reason: "workspace_cleared" };
    const goal = tx.goals.get(ownerId, goalId);
    const run = tx.support.getAgentRun(ownerId, turn.runId);
    const operation = tx.support.getOperation(ownerId, turn.operationEntityId);
    if (!goal || !run || !operation) return { status: "cancelled", reason: "turn_deleted" };
    const stored = record(operation);
    if (stored.phase !== "running" || stored.runId !== run.id) invalid();
    return { status: "live", current: { goal, run, operation, setting } };
  }
}
