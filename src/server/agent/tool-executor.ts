import { z } from "zod";
import type { AgentState, Operation } from "@/core/domain/contracts";
import { JsonObjectSchema } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type { AuditService } from "../audit/audit-service";
import type { OperationService } from "../operations/operation-service";
import type { RecordTaskPatchInput, UndoService } from "../operations/undo-service";
import type { Repositories, TransactionRepositories } from "../repositories/repository-types";
import { PlanRevisionPayloadSchema } from "../repositories/revision-contracts";
import type { ApprovalService } from "../security/approval-service";
import { contentHash } from "../security/canonical-json";
import { authorizeTool, authorizeToolSource, type ToolDecision } from "./permission-gate";
import { GoalContractDraftPayloadSchema, toolContracts } from "./tool-contracts";
import { isToolName, toolRegistry, type ProtectedToolName, type ToolArgs, type ToolName, type ToolResult, type ToolSource } from "./tool-registry";
import { goalCheckpoint, observeDomainWrites, type GoalCheckpoint } from "./domain-write-observer";

export type { GoalCheckpoint } from "./domain-write-observer";
export type ExecuteToolInput<N extends ToolName> = { toolName: N; args: unknown; context: TrustedToolContext };
export type ToolObservation =
  | { disposition: "read"; committedDomainMutation: false }
  | { disposition: "replayed"; committedDomainMutation: false }
  | { disposition: "committed"; committedDomainMutation: boolean; goalBefore: GoalCheckpoint | null; goalAfter: GoalCheckpoint | null };
export type ObservedToolResult<N extends ToolName> = { result: ToolResult<N>; observation: ToolObservation };

/** Constructed only by server callers after source/origin and intent verification. */
export type TrustedToolContext = {
  ownerId: string; source: ToolSource; goalId?: string;
  operationId?: string; explicitIntent?: boolean;
  expectedFenceRevision?: number;
};
export type ReadToolName = "get_goal" | "list_tasks" | "get_progress" | "diagnose_blocker";
export type MutationToolName = Exclude<ToolName, ReadToolName>;
export type ReadToolRepositories = {
  goals: Pick<Repositories["goals"], "get">;
  tasks: Pick<Repositories["tasks"], "get" | "listByGoal">;
  plans: Pick<Repositories["plans"], "getCurrent">;
  support: Pick<Repositories["support"], "listCheckInsByGoal" | "listEvidenceByTask">;
};
export type ReadToolContext = { ownerId: string; goalId: string; repositories: ReadToolRepositories };
export type MutationToolContext = {
  ownerId: string; goalId: string | null; operation: Operation; source: ToolSource;
  repositories: TransactionRepositories;
  undo: {
    recordTaskPatch(input: Omit<RecordTaskPatchInput, "ownerId">): ReturnType<UndoService["recordTaskPatchInTransaction"]>;
    undoLast(goalId: string, binding?: { expectedUndoId?: string; expectedGoalVersion?: number }): ReturnType<UndoService["undoLastInTransaction"]>;
  };
};
export type ToolHandlers = {
  [N in ToolName]: N extends ReadToolName
    ? (args: ToolArgs<N>, context: ReadToolContext) => ToolResult<N> | Promise<ToolResult<N>>
    : (args: ToolArgs<N>, context: MutationToolContext) => ToolResult<N>;
};
const reviewSchemas = {
  save_approved_contract: GoalContractDraftPayloadSchema,
  save_approved_plan: PlanRevisionPayloadSchema,
  delete_task: toolContracts.delete_task.args,
  delete_goal: toolContracts.delete_goal.args,
  clear_all_data: toolContracts.clear_all_data.args,
} as const;
export type ApprovalReview<N extends ProtectedToolName> = {
  payload: z.infer<(typeof reviewSchemas)[N]>;
  grantId?: string;
};
/** Trusted Task 12 code verifies draft status/version/content hash/base versions,
 * or exact UI confirmation and target versions, before returning. The clear
 * reviewer must match args.expectedSettingId to the current AppSetting.id.
 * These callbacks run only for new operations, inside the same transaction;
 * never obtain them from browser/model input or perform async preparation here.
 */
export type ApprovalReviewers = {
  [N in ProtectedToolName]?: (args: ToolArgs<N>, context: MutationToolContext) => ApprovalReview<N>;
};
export type ToolExecutorDependencies = {
  repositories: Repositories; operations: OperationService; approvals: ApprovalService;
  audit: AuditService; undo: UndoService; handlers: ToolHandlers;
  approvalReviewers: ApprovalReviewers; now?: () => Date;
};
function assertAllowed(decision: ToolDecision): void {
  if (!decision.allowed) throw new AppError(decision.code, decision.code === "INVALID_TRANSITION" ? 409 : 403, "Tool authorization denied");
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", 400, "Tool contract validation failed");
  return parsed.data;
}
function rejectThenable(value: unknown): void {
  if (value !== null && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => undefined);
    throw new AppError("VALIDATION_ERROR", 400, "Mutation handlers must be synchronous");
  }
}
function isReadTool(name: ToolName): name is ReadToolName {
  return name === "get_goal" || name === "list_tasks" || name === "get_progress" || name === "diagnose_blocker";
}
function isProtected(name: ToolName): name is ProtectedToolName {
  return toolRegistry[name].permissionClass === "structural" || toolRegistry[name].permissionClass === "destructive";
}
function assertTargetGoal(target: { goalId: string } | null, goalId: string): void {
  if (!target) throw new AppError("NOT_FOUND", 404, "Tool target is unavailable");
  if (target.goalId !== goalId) throw new AppError("OWNERSHIP_MISMATCH", 403, "Tool target belongs to another goal");
}

export class ToolExecutor {
  private readonly reads: ReadToolRepositories;
  private readonly now: () => Date;
  constructor(private readonly dependencies: ToolExecutorDependencies) {
    const r = dependencies.repositories;
    // Construct a narrow runtime surface too; a type-only Pick would leak writes.
    this.reads = {
      goals: { get: (owner, id) => r.goals.get(owner, id) },
      tasks: { get: (owner, id) => r.tasks.get(owner, id), listByGoal: (owner, id, plan) => r.tasks.listByGoal(owner, id, plan) },
      plans: { getCurrent: (owner, id) => r.plans.getCurrent(owner, id) },
      support: { listCheckInsByGoal: (owner, id) => r.support.listCheckInsByGoal(owner, id), listEvidenceByTask: (owner, id) => r.support.listEvidenceByTask(owner, id) },
    };
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute<N extends ToolName>(input: ExecuteToolInput<N>): Promise<ToolResult<N>> {
    return (await this.executeObserved(input)).result;
  }

  async executeObserved<N extends ToolName>(input: ExecuteToolInput<N>): Promise<ObservedToolResult<N>> {
    return this.executeInternal(input);
  }

  private async executeInternal<N extends ToolName>(input: ExecuteToolInput<N>): Promise<ObservedToolResult<N>> {
    const { toolName, context } = input;
    if (!isToolName(toolName)) throw new AppError("VALIDATION_ERROR", 400, "Unknown tool");
    const definition = toolRegistry[toolName];
    const args = parse(definition.argsSchema as z.ZodType<ToolArgs<ToolName>>, input.args) as ToolArgs<N>;
    const authorization = { toolName, ownerId: context.ownerId, source: context.source, explicitIntent: context.explicitIntent };
    assertAllowed(authorizeToolSource(authorization));
    const goalId = "goalId" in args ? args.goalId : null;
    if (goalId !== null && goalId !== context.goalId) throw new AppError("OWNERSHIP_MISMATCH", 403, "Tool target differs from trusted goal scope");
    const resultSchema = definition.resultSchema as z.ZodType<ToolResult<ToolName>>;

    if (isReadTool(toolName)) {
      const readGoalId = goalId as string;
      const goal = await this.reads.goals.get(context.ownerId, readGoalId);
      if (!goal && toolName !== "get_goal") throw new AppError("NOT_FOUND", 404, "Goal is unavailable");
      assertAllowed(authorizeTool({ ...authorization, state: goal?.agentState ?? "intake" }));
      if ("taskId" in args && args.taskId !== null)
        assertTargetGoal(await this.reads.tasks.get(context.ownerId, args.taskId), readGoalId);
      if (context.expectedFenceRevision !== undefined && (await this.dependencies.repositories.conversations.getSnapshot(context.ownerId, readGoalId)).fenceRevision !== context.expectedFenceRevision)
        throw new AppError("VERSION_CONFLICT", 409, "Agent context was withdrawn");
      // Name, parsed schema, and mapped handler share the same discriminant.
      const handler = this.dependencies.handlers[toolName] as unknown as (a: ToolArgs<N>, c: ReadToolContext) => ToolResult<N> | Promise<ToolResult<N>>;
      return { result: parse(resultSchema, await handler(args, { ownerId: context.ownerId, goalId: readGoalId, repositories: this.reads })) as ToolResult<N>, observation: { disposition: "read", committedDomainMutation: false } };
    }
    if (!context.operationId?.trim()) throw new AppError("VALIDATION_ERROR", 400, "Mutation operation ID is required");
    let candidate: ToolObservation | null = null;
    const outcome = await this.dependencies.operations.executeOnce({
      ownerId: context.ownerId, operationId: context.operationId, toolName,
      scope: toolName === "delete_goal" || toolName === "clear_all_data" ? { kind: "ownerTombstone" } : { kind: "goal", goalId: goalId as string },
      parameters: args,
      execute: ({ operation, repositories: original }) => {
        if (context.expectedFenceRevision !== undefined && goalId !== null && original.conversations.getSnapshot(context.ownerId, goalId).fenceRevision !== context.expectedFenceRevision)
          throw new AppError("VERSION_CONFLICT", 409, "Agent context was withdrawn");
        const observer = observeDomainWrites(original);
        const repositories = observer.repositories;
        const goal = goalId === null ? null : repositories.goals.get(context.ownerId, goalId);
        const goalBefore = goalCheckpoint(goal);
        if (goalId !== null && !goal) throw new AppError("NOT_FOUND", 404, "Goal is unavailable");
        const state: AgentState = goal?.agentState ?? "intake";
        const preliminary = authorizeTool({ ...authorization, state });
        if (!preliminary.allowed && preliminary.code !== "APPROVAL_REQUIRED") assertAllowed(preliminary);
        if ("taskId" in args && args.taskId !== null)
          assertTargetGoal(repositories.tasks.get(context.ownerId, args.taskId), goalId as string);
        if ("draftId" in args)
          assertTargetGoal(repositories.plans.getDraftArtifact(context.ownerId, args.draftId), goalId as string);
        const handlerContext: MutationToolContext = {
          ownerId: context.ownerId, goalId, operation, repositories, source: context.source,
          undo: {
            recordTaskPatch: values => this.dependencies.undo.recordTaskPatchInTransaction(repositories, { ...values, ownerId: context.ownerId }),
            undoLast: (id, binding) => this.dependencies.undo.undoLastInTransaction(repositories, { ownerId: context.ownerId, goalId: id, ...binding }),
          },
        };
        if (isProtected(toolName)) {
          this.approve(toolName, args as ToolArgs<ProtectedToolName>, handlerContext, { ...authorization, state });
        } else assertAllowed(preliminary);
        const handler = this.dependencies.handlers[toolName] as unknown as (a: ToolArgs<N>, c: MutationToolContext) => ToolResult<N>;
        const rawResult = handler(args, handlerContext);
        rejectThenable(rawResult);
        const result = parse(resultSchema, rawResult);
        // Clear retains only its content-free Operation tombstone. Goal deletion
        // cannot retain a foreign key to the deleted subject.
        if (toolName !== "clear_all_data") this.dependencies.audit.recordInTransaction(repositories.support, {
          ownerId: context.ownerId, goalId: toolName === "delete_goal" ? null : goalId,
          type: "tool_executed", entityType: "goal", entityId: goalId as string,
          detail: { toolName, source: context.source },
        });
        const json = parse(JsonObjectSchema, result);
        candidate = Object.freeze({ disposition: "committed", committedDomainMutation: observer.hasDomainWrite(), goalBefore, goalAfter: goalCheckpoint(goalId === null ? null : repositories.goals.get(context.ownerId, goalId)) });
        return json;
      },
    });
    // Persisted replay results also cross the current tool contract boundary.
    return { result: parse(resultSchema, outcome) as ToolResult<N>, observation: candidate ?? { disposition: "replayed", committedDomainMutation: false } };
  }

  private approve(name: ProtectedToolName, args: ToolArgs<ProtectedToolName>, context: MutationToolContext, authorization: Parameters<typeof authorizeTool>[0]): void {
    const reviewer = this.dependencies.approvalReviewers[name] as ((a: ToolArgs<ProtectedToolName>, c: MutationToolContext) => ApprovalReview<ProtectedToolName>) | undefined;
    if (!reviewer) throw new AppError("APPROVAL_REQUIRED", 403, "Trusted review is required");
    const raw = reviewer(args, context);
    rejectThenable(raw);
    const reviewed = parse(z.object({ payload: reviewSchemas[name], grantId: z.string().uuid().optional() }).strict(), raw);
    const subjectId = "draftId" in args ? args.draftId : "taskId" in args ? args.taskId : "goalId" in args ? args.goalId : context.ownerId;
    const binding = { ownerId: context.ownerId, subjectId, toolName: name, payload: reviewed.payload };
    const grant = reviewed.grantId
      ? context.repositories.support.getApprovalGrant(context.ownerId, reviewed.grantId)
      : this.dependencies.approvals.issueInTransaction(context.repositories.support, binding);
    if (!grant) throw new AppError("APPROVAL_INVALID", 403, "Approval is unavailable");
    assertAllowed(authorizeTool({ ...authorization, approval: { grant, subjectId, contentHash: contentHash(reviewed.payload), now: this.now().toISOString() } }));
    this.dependencies.approvals.consumeInTransaction(context.repositories.support, { ...binding, grantId: grant.id });
  }
}
