import { z } from "zod";
import {
  type UndoResult,
  type UndoRecord,
} from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type {
  Repositories,
  RepositoryUnitOfWork,
  SupportRepository,
  SyncRepository,
  TransactionRepositories,
} from "../repositories/repository-types";
import { TaskExecutionPatchSchema, undoCandidate } from "./undo-candidate";
export { TaskExecutionPatchSchema } from "./undo-candidate";

export type TaskExecutionPatch = z.infer<typeof TaskExecutionPatchSchema>;
export type UndoInput = { ownerId: string; goalId: string; expectedUndoId?: string; expectedGoalVersion?: number };

export type RecordTaskPatchInput = {
  ownerId: string;
  goalId: string;
  taskId: string;
  before: TaskExecutionPatch;
  after: TaskExecutionPatch;
};

type UndoRepositories = Repositories & RepositoryUnitOfWork;

function invalid(
  code: "VALIDATION_ERROR" | "INVALID_TRANSITION" | "VERSION_CONFLICT",
  message: string,
): never {
  throw new AppError(code, code === "VALIDATION_ERROR" ? 400 : 409, message);
}

function patches(input: RecordTaskPatchInput) {
  const before = TaskExecutionPatchSchema.safeParse(input.before);
  const after = TaskExecutionPatchSchema.safeParse(input.after);
  if (!before.success || !after.success) {
    invalid("VALIDATION_ERROR", "Undo records contain execution fields only");
  }
  return { before: before.data, after: after.data };
}

function record(
  support: SyncRepository<SupportRepository>,
  input: RecordTaskPatchInput,
): UndoRecord {
  const values = patches(input);
  return support.createUndoRecord(input.ownerId, {
    goalId: input.goalId,
    taskId: input.taskId,
    forwardPatch: values.after,
    reversePatch: values.before,
  });
}

function undoLatest(
  repositories: TransactionRepositories,
  input: UndoInput,
  now: Date,
): UndoResult {
  const selection = undoCandidate(repositories, input.ownerId, input.goalId);
  const latest = selection.latest;
  const goal = repositories.goals.get(input.ownerId, input.goalId);
  if (input.expectedUndoId !== undefined && (latest?.id !== input.expectedUndoId || goal?.version !== input.expectedGoalVersion)) invalid("VERSION_CONFLICT", "Displayed undo candidate has changed");
  if (!latest) invalid("INVALID_TRANSITION", "There is no pending undo for this goal");
  if (!selection.canUndo) invalid("VERSION_CONFLICT", selection.reason!);
  if (latest.kind === "check_in") {
    const checkIn = repositories.support.getCheckIn(input.ownerId, latest.checkInId!);
    if (!checkIn) invalid("VERSION_CONFLICT", "Feedback is unavailable");
    const withdrawnAt = now.toISOString();
    const restored = repositories.support.withdrawCheckIn(input.ownerId, checkIn.id, checkIn.version, withdrawnAt);
    const revision = Math.max(0, ...repositories.support.listUndoRecordsByGoal(input.ownerId, input.goalId).map(row => row.conversationFence?.revision ?? 0)) + 1;
    const throughMessageId = repositories.conversations.last(input.ownerId, input.goalId, 1).at(-1)?.id ?? null;
    const throughAgentTurnOperationId = repositories.support.listSucceededAgentTurnOperations(input.ownerId, input.goalId).at(-1)?.id ?? null;
    repositories.support.updateUndoRecord(input.ownerId, latest.id, latest.version, { undoneAt: withdrawnAt, conversationFence: { revision, throughMessageId, throughAgentTurnOperationId } });
    return { checkIn: restored };
  }
  const task = repositories.tasks.get(input.ownerId, latest.taskId!);
  const plan = repositories.plans.getCurrent(input.ownerId, input.goalId);
  if (
    !task
    || !goal
    || !plan
    || plan.status !== "approved"
    || goal.currentPlanVersionId !== plan.id
    || task.goalId !== goal.id
    || task.planVersionId !== plan.id
  ) {
    invalid("VERSION_CONFLICT", "Newest undo does not belong to the current approved plan");
  }
  const forward = TaskExecutionPatchSchema.safeParse(latest.forwardPatch);
  const reverse = TaskExecutionPatchSchema.safeParse(latest.reversePatch);
  if (!forward.success || !reverse.success) {
    invalid("VALIDATION_ERROR", "Stored undo patch is invalid");
  }
  if (
    task.status !== forward.data.status
    || task.actualMinutes !== forward.data.actualMinutes
  ) {
    invalid("VERSION_CONFLICT", "Task execution changed after the undo record");
  }
  const restored = repositories.tasks.update(
    input.ownerId,
    task.id,
    task.version,
    reverse.data,
  );
  repositories.support.updateUndoRecord(
    input.ownerId,
    latest.id,
    latest.version,
    { undoneAt: now.toISOString() },
  );
  return { task: restored };
}

export class UndoService {
  constructor(
    private readonly repositories: UndoRepositories,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordTaskPatch(input: RecordTaskPatchInput): Promise<UndoRecord> {
    const values = patches(input);
    return this.repositories.support.createUndoRecord(input.ownerId, {
      goalId: input.goalId,
      taskId: input.taskId,
      forwardPatch: values.after,
      reversePatch: values.before,
    });
  }

  recordTaskPatchInTransaction(
    repositories: TransactionRepositories,
    input: RecordTaskPatchInput,
  ): UndoRecord {
    return record(repositories.support, input);
  }

  undoLast(input: UndoInput): Promise<UndoResult> {
    return this.repositories.withTransaction(repositories =>
      undoLatest(repositories, input, this.now()));
  }

  undoLastInTransaction(
    repositories: TransactionRepositories,
    input: UndoInput,
  ): UndoResult {
    return undoLatest(repositories, input, this.now());
  }
}
