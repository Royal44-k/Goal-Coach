import { describe, expect, it } from "vitest";
import { AgentStateSchema, type ApprovalGrant, type AgentState } from "@/core/domain/contracts";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { authorizeTool } from "./permission-gate";
import type { ToolName } from "./tool-registry";

const ownerId = LOCAL_OWNER_ID;
const subjectId = "00000000-0000-4000-8000-000000000010";
const now = "2026-09-16T00:01:00.000Z";
const grant: ApprovalGrant = {
  id: "00000000-0000-4000-8000-000000000011", ownerId, subjectId,
  contentHash: "a".repeat(64), allowedTool: "delete_goal",
  createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
  expiresAt: "2026-09-16T00:15:00.000Z", usedAt: null, version: 1,
};
const approval = { grant, subjectId, contentHash: grant.contentHash, now };
const states: Record<ToolName, readonly AgentState[]> = {
  get_goal: AgentStateSchema.options,
  list_tasks: ["planning", "plan_review", "active", "reviewing", "replanning", "paused", "completed"],
  get_progress: ["planning", "plan_review", "active", "reviewing", "replanning", "paused", "completed"],
  create_goal_contract_draft: ["intake", "clarifying", "contract_review"],
  create_plan_draft: ["planning"], diagnose_blocker: ["active", "reviewing"],
  propose_replan: ["active", "reviewing", "replanning"],
  record_check_in: ["active", "reviewing"], update_task_status: ["active", "reviewing"],
  undo_last_change: ["active", "reviewing", "paused"], save_approved_contract: ["contract_review"],
  save_approved_plan: ["plan_review", "paused"], delete_task: ["active", "paused"],
  delete_goal: ["intake", "clarifying", "contract_review", "planning", "plan_review", "active", "paused", "completed"],
  clear_all_data: AgentStateSchema.options,
};

describe("new-operation permission boundary", () => {
  it("accepts a verified UUID owner while preserving approval owner binding", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    expect(authorizeTool({ toolName: "get_goal", ownerId: other, source: "model", state: "intake" })).toEqual({ allowed: true });
    expect(authorizeTool({ toolName: "delete_goal", ownerId: other, source: "ui_confirmation", state: "active", approval })).toEqual({ allowed: false, code: "APPROVAL_INVALID" });
    expect(authorizeTool({ toolName: "delete_goal", ownerId: other, source: "ui_confirmation", state: "active", approval: { ...approval, grant: { ...grant, ownerId: other } } })).toEqual({ allowed: true });
  });
  for (const [toolName, allowed] of Object.entries(states)) {
    it.each(AgentStateSchema.options)(`${toolName} state %s`, state => {
      const decision = authorizeTool({ toolName, ownerId, source: "ui_confirmation", state,
        approval: { ...approval, grant: { ...grant, allowedTool: toolName } } });
      expect(decision).toEqual(allowed.includes(state) ? { allowed: true } : { allowed: false, code: "INVALID_TRANSITION" });
    });
  }
  it("allows model reads and drafts but requires explicit intent for reversible writes", () => {
    for (const [toolName, state] of [["get_progress", "active"], ["create_plan_draft", "planning"]] as const)
      expect(authorizeTool({ toolName, ownerId, source: "model", state })).toEqual({ allowed: true });
    for (const toolName of ["record_check_in", "update_task_status", "undo_last_change"] as const) {
      expect(authorizeTool({ toolName, ownerId, source: "model", state: "active" })).toEqual({ allowed: false, code: "APPROVAL_REQUIRED" });
      expect(authorizeTool({ toolName, ownerId, source: "model", state: "active", explicitIntent: true })).toEqual({ allowed: true });
    }
  });
  it("rejects save_approved_plan without grant even with a correct model request", () => {
    expect(authorizeTool({ toolName: "save_approved_plan", ownerId, source: "model", state: "plan_review" }))
      .toEqual({ allowed: false, code: "APPROVAL_REQUIRED" });
    expect(authorizeTool({ toolName: "save_approved_plan", ownerId, source: "ui_explicit", state: "plan_review" }))
      .toEqual({ allowed: false, code: "APPROVAL_REQUIRED" });
  });
  it("never accepts a model grant or a destructive first-click source", () => {
    for (const toolName of ["save_approved_plan", "save_approved_contract", "delete_task", "delete_goal", "clear_all_data"])
      expect(authorizeTool({ toolName, ownerId, source: "model", state: "active", approval })).toEqual({ allowed: false, code: "APPROVAL_REQUIRED" });
    expect(authorizeTool({ toolName: "delete_goal", ownerId, source: "ui_explicit", state: "active", approval })).toEqual({ allowed: false, code: "APPROVAL_REQUIRED" });
  });
  it("orders known name, trusted owner, source, state, then grant binding", () => {
    expect(authorizeTool({ toolName: "toString", ownerId: "bad", source: "model", state: "active" })).toEqual({ allowed: false, code: "VALIDATION_ERROR" });
    expect(authorizeTool({ toolName: "get_goal", ownerId: "bad", source: "model", state: "active" })).toEqual({ allowed: false, code: "OWNERSHIP_MISMATCH" });
    expect(authorizeTool({ toolName: "get_goal", ownerId, source: "spoofed" as never, state: "active" })).toEqual({ allowed: false, code: "ORIGIN_REJECTED" });
    expect(authorizeTool({ toolName: "delete_goal", ownerId, source: "ui_confirmation", state: "reviewing" })).toEqual({ allowed: false, code: "INVALID_TRANSITION" });
    expect(authorizeTool({ toolName: "get_goal", ownerId, source: "model", state: "spoofed" as never })).toEqual({ allowed: false, code: "INVALID_TRANSITION" });
  });
  it.each([
    { ownerId: subjectId }, { subjectId: ownerId }, { contentHash: "b".repeat(64) },
    { allowedTool: "delete_task" }, { usedAt: now }, { expiresAt: now }, { expiresAt: "invalid" },
  ])("denies changed or spent full grant binding %j", change => {
    expect(authorizeTool({ toolName: "delete_goal", ownerId, source: "ui_confirmation", state: "active",
      approval: { ...approval, grant: { ...grant, ...change } } })).toEqual({ allowed: false, code: "APPROVAL_INVALID" });
  });
});
