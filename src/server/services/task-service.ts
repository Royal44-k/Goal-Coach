import { AppError } from "@/core/errors/app-error";
import type { ToolExecutor } from "../agent/tool-executor";
import type { ToolSource } from "../agent/tool-registry";
import { authorizeTool, authorizeToolSource } from "../agent/permission-gate";
import type { OperationService } from "../operations/operation-service";
import type { UndoService } from "../operations/undo-service";
import { CheckInInputSchema, DeleteTaskSchema, TaskUpdateSchema, UndoInputSchema, id } from "./service-contracts";
import { applyTaskExecution } from "./task-execution";
import { conflict, requireGoal } from "./draft-preparation";
export class TaskService {
  constructor(private readonly tools: ToolExecutor, private readonly operations: OperationService, private readonly undoService: UndoService) {}
  async update(ownerId: string, taskId: string, raw: unknown, source: ToolSource) {
    id.parse(taskId); const input = TaskUpdateSchema.parse(raw);
    const authorization = { toolName: "update_task_status" as const, ownerId, source, explicitIntent: true };
    const permission = authorizeToolSource(authorization);
    if (!permission.allowed || source !== "ui_explicit") throw new AppError("ORIGIN_REJECTED", 403, "UI execution source required");
    return this.operations.executeOnce({ ownerId, operationId: input.operationId, toolName: "update_task_status", scope: { kind: "goal", goalId: input.goalId }, parameters: { taskId, ...input }, execute: ({ operation, repositories: tx }) => {
      const goal = requireGoal(tx, ownerId, input.goalId);
      const decision = authorizeTool({ ...authorization, state: goal.agentState });
      if (!decision.allowed || goal.status !== "active") throw new AppError("INVALID_TRANSITION", 409, "Execution state unavailable");
      const plan = tx.plans.getCurrent(ownerId, goal.id);
      if (goal.version !== input.expectedGoalVersion || !plan || plan.id !== input.expectedPlanVersion.id || plan.version !== input.expectedPlanVersion.version) conflict();
      const task = applyTaskExecution({ ownerId, goalId: goal.id, operation, repositories: tx, source, undo: { recordTaskPatch: values => this.undoService.recordTaskPatchInTransaction(tx, { ownerId, ...values }), undoLast: goalId => this.undoService.undoLastInTransaction(tx, { ownerId, goalId }) } }, { goalId: goal.id, taskId, expectedTaskVersion: input.expectedVersion, status: input.status, actualMinutes: input.actualMinutes }, "evidence" in input ? input.evidence : undefined);
      tx.support.createAuditEvent(ownerId, { goalId: goal.id, type: "tool_executed", entityType: "task", entityId: task.id, detail: { toolName: "update_task_status", source } });
      return task;
    } });
  }
  async remove(ownerId: string, taskId: string, raw: unknown): Promise<void> {
    id.parse(taskId); const { operationId, source, confirmationPhrase, ...args } = DeleteTaskSchema.parse(raw);
    await this.tools.execute({ toolName: "delete_task", args: { ...args, taskId, confirmation: confirmationPhrase }, context: { ownerId, goalId: args.goalId, operationId, source } });
  }
  async recordCheckIn(ownerId: string, goalId: string, raw: unknown) {
    id.parse(goalId); const { operationId, ...args } = CheckInInputSchema.parse(raw);
    return (await this.tools.execute({ toolName: "record_check_in", args: { ...args, goalId }, context: { ownerId, goalId, operationId, source: "ui_explicit", explicitIntent: true } })).checkIn;
  }
  async undo(ownerId: string, goalId: string, raw: unknown) {
    id.parse(goalId); const { operationId, ...binding } = UndoInputSchema.parse(raw);
    return this.tools.execute({ toolName: "undo_last_change", args: { goalId, ...binding }, context: { ownerId, goalId, operationId, source: "ui_explicit", explicitIntent: true } });
  }
}
