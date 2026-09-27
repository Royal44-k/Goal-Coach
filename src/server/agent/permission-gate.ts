import { AgentStateSchema, type AgentState, type ApprovalGrant } from "@/core/domain/contracts";
import type { AppErrorCode } from "@/core/errors/app-error";
import { z } from "zod";
import { isToolName, toolRegistry, type ToolSource } from "./tool-registry";

export type ToolDecision = { allowed: true } | { allowed: false; code: AppErrorCode };
export type SourceAuthorization = {
  toolName: string;
  ownerId: string;
  source: ToolSource;
  explicitIntent?: boolean;
};
export type ToolAuthorization = SourceAuthorization & {
  state: AgentState;
  approval?: { grant: ApprovalGrant; subjectId: string; contentHash: string; now: string };
};
const deny = (code: AppErrorCode): ToolDecision => ({ allowed: false, code });

/** Static trust checks run even for an exact successful operation replay. */
export function authorizeToolSource(input: SourceAuthorization): ToolDecision {
  if (!isToolName(input.toolName)) return deny("VALIDATION_ERROR");
  if (!z.uuid().safeParse(input.ownerId).success) return deny("OWNERSHIP_MISMATCH");
  if (!["model", "ui_explicit", "ui_confirmation"].includes(input.source)) return deny("ORIGIN_REJECTED");
  const permission = toolRegistry[input.toolName].permissionClass;
  if (permission === "destructive" && input.source !== "ui_confirmation") return deny("APPROVAL_REQUIRED");
  if (permission === "structural" && input.source === "model") return deny("APPROVAL_REQUIRED");
  if (permission === "reversible" && input.source === "model" && input.explicitIntent !== true) return deny("APPROVAL_REQUIRED");
  return { allowed: true };
}

/** Grant IDs alone are not authority. The caller supplies the persisted binding. */
export function authorizeTool(input: ToolAuthorization): ToolDecision {
  const source = authorizeToolSource(input);
  if (!source.allowed) return source;
  // The source check established the key; this lookup never follows the prototype.
  const definition = toolRegistry[input.toolName as keyof typeof toolRegistry];
  if (!AgentStateSchema.safeParse(input.state).success || !(definition.allowedStates as readonly string[]).includes(input.state)) return deny("INVALID_TRANSITION");
  if (definition.permissionClass !== "structural" && definition.permissionClass !== "destructive") return { allowed: true };
  if (!input.approval) return deny("APPROVAL_REQUIRED");
  const { grant, subjectId, contentHash, now } = input.approval;
  if (grant.ownerId !== input.ownerId || grant.subjectId !== subjectId
    || grant.allowedTool !== input.toolName || grant.contentHash !== contentHash
    || grant.usedAt !== null || !(Date.parse(grant.expiresAt) > Date.parse(now))) return deny("APPROVAL_INVALID");
  return { allowed: true };
}
