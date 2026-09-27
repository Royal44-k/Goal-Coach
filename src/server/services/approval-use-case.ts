import type { ToolExecutor } from "../agent/tool-executor";
import { ApproveSchema } from "./service-contracts";
export class ApprovalUseCase {
  constructor(private readonly tools: ToolExecutor) {}
  approve(ownerId: string, raw: unknown) {
    const { operationId, toolName, ...args } = ApproveSchema.parse(raw);
    return this.tools.execute({ toolName, args, context: { ownerId, goalId: args.goalId, operationId, source: "ui_explicit" } });
  }
}
