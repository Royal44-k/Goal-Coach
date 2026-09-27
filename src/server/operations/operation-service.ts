import {
  JsonObjectSchema,
  type JsonValue,
  type Operation,
} from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type {
  Repositories,
  RepositoryUnitOfWork,
  TransactionRepositories,
} from "../repositories/repository-types";
import { canonicalJson, contentHash } from "../security/canonical-json";

export type JsonObject = Record<string, JsonValue>;

export type OperationScope =
  | { kind: "goal"; goalId: string }
  | { kind: "ownerTombstone" };

export type OperationExecutionContext = {
  operation: Operation;
  repositories: TransactionRepositories;
};

export type ExecuteOnceInput<R extends JsonObject> = {
  ownerId: string;
  operationId: string;
  toolName: string;
  scope: OperationScope;
  parameters: unknown;
  execute: (context: OperationExecutionContext) => R;
};

type OperationRepositories = Repositories & RepositoryUnitOfWork;

function invalid(message: string): never {
  throw new AppError("VALIDATION_ERROR", 400, message);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

function storedResult<R extends JsonObject>(value: unknown): R {
  const canonical = canonicalJson(value);
  const parsed = JsonObjectSchema.safeParse(JSON.parse(canonical));
  if (!parsed.success) invalid("Operation result must be a JSON object");
  return parsed.data as R;
}

function scopedGoalId(scope: OperationScope, toolName: string): string | null {
  const requiresTombstone = toolName === "delete_goal" || toolName === "clear_all_data";
  if (scope.kind === "goal") {
    if (requiresTombstone) {
      invalid("Delete and clear operations require an owner tombstone");
    }
    return scope.goalId;
  }
  if (!requiresTombstone) {
    invalid("Owner tombstones are reserved for destructive owner-bound operations");
  }
  return null;
}

export class OperationService {
  constructor(private readonly repositories: OperationRepositories) {}

  async executeOnce<R extends JsonObject>(input: ExecuteOnceInput<R>): Promise<R> {
    const operationId = input.operationId.trim();
    const toolName = input.toolName.trim();
    if (!operationId || !toolName) invalid("Operation and tool names are required");
    const goalId = scopedGoalId(input.scope, toolName);
    const parameterHash = contentHash(input.parameters);

    const outcome = await this.repositories.withTransaction<JsonObject>((repositories) => {
      const existing = repositories.support.getOperationByOperationId(
        input.ownerId,
        operationId,
      );
      if (existing) {
        if (
          existing.toolName !== toolName
          || existing.parameterHash !== parameterHash
          || existing.goalId !== goalId
          || existing.status !== "succeeded"
          || existing.result === null
        ) {
          invalid("Operation ID is already bound to another or incomplete operation");
        }
        return storedResult<R>(existing.result);
      }

      const operation = repositories.support.createOperation(input.ownerId, {
        goalId,
        operationId,
        toolName,
        parameterHash,
      });
      const result = input.execute({ operation, repositories });
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        invalid("Operation callbacks must be synchronous");
      }
      const jsonResult = storedResult<R>(result);
      repositories.support.updateOperation(
        input.ownerId,
        operation.id,
        operation.version,
        { status: "succeeded", result: jsonResult },
      );
      return jsonResult;
    });
    return outcome as R;
  }
}
