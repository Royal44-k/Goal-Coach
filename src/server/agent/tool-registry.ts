import { z } from "zod";
import { AgentStateSchema, type AgentState } from "@/core/domain/contracts";
import { toolContracts, type ToolName } from "./tool-contracts";
import { modelPlanProposalArgsSchema } from "./model-plan-proposal";
export type { ToolName, ToolArgs, ToolResult } from "./tool-contracts";

export type PermissionClass = "read" | "draft" | "reversible" | "structural" | "destructive";
export type ToolSource = "model" | "ui_explicit" | "ui_confirmation";
export type ToolDefinition<N extends ToolName = ToolName> = {
  name: N; description: string; permissionClass: PermissionClass;
  allowedStates: readonly AgentState[];
  argsSchema: (typeof toolContracts)[N]["args"];
  resultSchema: (typeof toolContracts)[N]["result"];
};
function define<N extends ToolName, P extends PermissionClass>(name: N, description: string, permissionClass: P, allowedStates: readonly AgentState[]): ToolDefinition<N> & { permissionClass: P } {
  return { name, description, permissionClass, allowedStates,
    argsSchema: toolContracts[name].args, resultSchema: toolContracts[name].result };
}
const planningStates: readonly AgentState[] = ["planning", "plan_review", "active", "reviewing", "replanning", "paused", "completed"];
export const toolRegistry = {
  get_goal: define("get_goal", "读取当前目标与目标契约", "read", AgentStateSchema.options),
  list_tasks: define("list_tasks", "读取当前计划的任务列表", "read", planningStates),
  get_progress: define("get_progress", "读取当前目标进度", "read", planningStates),
  create_goal_contract_draft: define("create_goal_contract_draft", "保存待用户确认的目标契约草案", "draft", ["intake", "clarifying", "contract_review"]),
  create_plan_draft: define("create_plan_draft", "保存待用户确认的初次计划草案", "draft", ["planning"]),
  diagnose_blocker: define("diagnose_blocker", "提供阻碍分析与最小下一步建议，不改变正式任务", "draft", ["active", "reviewing"]),
  propose_replan: define("propose_replan", "保存待用户确认的重排草案与执行重置说明", "draft", ["active", "reviewing", "replanning"]),
  record_check_in: define("record_check_in", "在用户明确要求时记录签到", "reversible", ["active", "reviewing"]),
  update_task_status: define("update_task_status", "在用户明确要求时更新任务状态或实际耗时", "reversible", ["active", "reviewing"]),
  undo_last_change: define("undo_last_change", "用户明确要求时撤销最近一次任务修改或反馈。使用上下文 undoCandidate.id 作为 expectedUndoId，并提供其 expectedGoalVersion；无候选时不可调用。", "reversible", ["active", "reviewing", "paused"]),
  save_approved_contract: define("save_approved_contract", "通过可信确认路径保存已批准的目标契约", "structural", ["contract_review"]),
  save_approved_plan: define("save_approved_plan", "通过可信确认路径保存已批准的计划", "structural", ["plan_review", "paused"]),
  delete_task: define("delete_task", "通过界面二次确认从后继计划移除任务", "destructive", ["active", "paused"]),
  delete_goal: define("delete_goal", "通过界面二次确认删除目标及其关联数据", "destructive", ["intake", "clarifying", "contract_review", "planning", "plan_review", "active", "paused", "completed"]),
  clear_all_data: define("clear_all_data", "通过界面二次确认清除当前用户业务数据", "destructive", AgentStateSchema.options),
} as const satisfies { [N in ToolName]: ToolDefinition<N> };

export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(toolRegistry, value);
}
export type ProtectedToolName = { [N in ToolName]: (typeof toolRegistry)[N]["permissionClass"] extends "structural" | "destructive" ? N : never }[ToolName];
export type ModelToolName = Exclude<ToolName, ProtectedToolName>;
export type ModelToolDefinition = {
  name: ModelToolName; description: string; inputSchema: z.core.JSONSchema.JSONSchema;
};
export function modelToolArgsSchema(name: ToolName) {
  return name === "create_plan_draft" || name === "propose_replan" ? modelPlanProposalArgsSchema : toolRegistry[name].argsSchema;
}
export function modelToolDefinitions(): ModelToolDefinition[] {
  return Object.values(toolRegistry).flatMap(definition =>
    definition.permissionClass === "structural" || definition.permissionClass === "destructive" ? [] : [{
      name: definition.name, description: definition.description,
      inputSchema: z.toJSONSchema(modelToolArgsSchema(definition.name), { io: "input" }),
    }]);
}
