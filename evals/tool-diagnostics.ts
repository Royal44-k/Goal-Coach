import type { ModelTurn } from "@/server/agent/model-contracts";
import { isToolName, modelToolArgsSchema } from "@/server/agent/tool-registry";
import { knownAssumptionViolations } from "@/server/agent/assumption-feedback";
import type { EvaluationResult } from "./schema";

type Diagnostic = NonNullable<EvaluationResult["providerCalls"][number]["argumentDiagnostics"]>[number];
// Intake fields only. Unknown path segments and array indexes are never copied verbatim.
const safeFields = new Set([
  "goalId", "expectedGoalVersion", "contract", "assumptions", "field", "reason",
  "title", "category", "desiredOutcome", "definitionOfDone", "deadline",
  "weeklyMinutes", "constraints", "motivation",
  "payload", "schemaVersion", "milestones", "base", "planVersionId", "goalVersion",
  "changeReason", "changeSource", "tasks", "id", "action", "doneCriteria",
  "evidenceType", "estimateMinutes", "dueAt", "dependencyIds", "executionResets",
  "taskKey", "diff", "added", "removed", "moved", "changed",
]);

/** Evaluation-only observation: never persists arguments, issue messages, or supplied values. */
export function diagnoseToolArguments(call: ModelTurn["toolCalls"][number]): Diagnostic {
  if (!isToolName(call.name)) return { toolName: "unknown", status: "unknown_tool", issues: [] };
  let args: unknown;
  try { args = JSON.parse(call.argumentsJson); }
  catch { return { toolName: call.name, status: "invalid_json", issues: [] }; }
  const parsed = modelToolArgsSchema(call.name).safeParse(args);
  if (parsed.success) return { toolName: call.name, status: "valid", issues: [] };
  return {
    toolName: call.name, status: "invalid_arguments",
    issues: parsed.error.issues.flatMap((issue): Diagnostic["issues"] => {
      if (call.name === "create_goal_contract_draft" && issue.code === "custom" && issue.message === "Assumptions must name unique non-null contract fields") {
        const rules = [...new Set(knownAssumptionViolations(args).map(item => item.rule))]
          .sort((a, b) => (a === "duplicate_assumption_field" ? 0 : 1) - (b === "duplicate_assumption_field" ? 0 : 1));
        if (rules.length) return rules.map(rule => ({ path: "assumptions", code: "custom", rule: rule === "null_contract_field" ? "null_contract_assumption_field" as const : rule }));
        return [{ path: "", code: "custom", rule: "unique_non_null_assumption_fields" as const }];
      }
      return [{
        path: issue.path.map(part => typeof part === "number" ? "[]" : typeof part === "string" && safeFields.has(part) ? part : "[redacted]").join("."),
        code: issue.code, rule: null,
      }];
    }),
  };
}
