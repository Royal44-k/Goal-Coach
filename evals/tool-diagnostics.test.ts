import { describe, expect, it } from "vitest";
import { observeModelClient, type ProviderCall } from "./run";
import { ProviderCallSchema } from "./schema";
import type { ModelTurn } from "@/server/agent/model-contracts";

const goalId = "a734ec72-4be3-4ca3-b7bf-09c0339b772c";
async function observe(toolCalls: ModelTurn["toolCalls"]) {
  const response: ModelTurn = { text: "", toolCalls, usage: { inputTokens: 3, outputTokens: 2 }, finishReason: "tool_calls" };
  const original = JSON.stringify(response);
  const calls: ProviderCall[] = [];
  const returned = await observeModelClient({ async complete() { return response; } }, calls).complete({ model: "synthetic-model", messages: [], tools: [] });
  expect(returned).toBe(response);
  expect(JSON.stringify(returned)).toBe(original);
  return ProviderCallSchema.parse(calls[0]);
}

describe("evaluation-only tool argument diagnostics", () => {
  it("records valid arguments without retaining their values or tool call IDs", async () => {
    const result = await observe([{ id: "private-call-id", name: "get_goal", argumentsJson: JSON.stringify({ goalId }) }]);
    expect(result.argumentDiagnostics).toEqual([{ toolName: "get_goal", status: "valid", issues: [] }]);
    expect(JSON.stringify(result)).not.toContain(goalId);
    expect(JSON.stringify(result)).not.toContain("private-call-id");
  });

  it("distinguishes syntax failures from schema failures without saving raw content", async () => {
    const result = await observe([
      { id: "syntax", name: "get_goal", argumentsJson: '{"goalId":"secret-do-not-log"' },
      { id: "schema", name: "get_goal", argumentsJson: '{"goalId":"secret-do-not-log"}' },
    ]);
    expect(result.argumentDiagnostics).toEqual([
      { toolName: "get_goal", status: "invalid_json", issues: [] },
      { toolName: "get_goal", status: "invalid_arguments", issues: [{ path: "goalId", code: "invalid_format", rule: null }] },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-do-not-log");
  });

  it("identifies the known cross-field assumption rule without logging goal text", async () => {
    const result = await observe([{ id: "assumption", name: "create_goal_contract_draft", argumentsJson: JSON.stringify({
      goalId, expectedGoalVersion: 1,
      contract: { title: "private-title", category: "learning", desiredOutcome: "private-outcome", definitionOfDone: "private-done", deadline: null, weeklyMinutes: 60, constraints: null, motivation: null },
      assumptions: [{ field: "deadline", reason: "private-reason" }],
    }) }]);
    expect(result.argumentDiagnostics).toEqual([{
      toolName: "create_goal_contract_draft", status: "invalid_arguments",
      issues: [{ path: "assumptions", code: "custom", rule: "null_contract_assumption_field" }],
    }]);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("distinguishes duplicate and null assumption errors without retaining field names or reasons", async () => {
    const result = await observe([{ id: "assumption", name: "create_goal_contract_draft", argumentsJson: JSON.stringify({
      goalId, expectedGoalVersion: 1,
      contract: { title: "private-title", category: "learning", desiredOutcome: "private-outcome", definitionOfDone: "private-done", deadline: null, weeklyMinutes: 60, constraints: null, motivation: null },
      assumptions: [{ field: "weeklyMinutes", reason: "private-one" }, { field: "weeklyMinutes", reason: "private-two" }, { field: "deadline", reason: "private-three" }],
    }) }]);
    expect(result.argumentDiagnostics).toEqual([{ toolName: "create_goal_contract_draft", status: "invalid_arguments", issues: [
      { path: "assumptions", code: "custom", rule: "duplicate_assumption_field" },
      { path: "assumptions", code: "custom", rule: "null_contract_assumption_field" },
    ] }]);
    expect(JSON.stringify(result.argumentDiagnostics)).not.toMatch(/weeklyMinutes|deadline|private-/);
  });

  it("keeps unknown property names and invalid enum values out of diagnostics", async () => {
    const result = await observe([{ id: "fields", name: "create_goal_contract_draft", argumentsJson: JSON.stringify({
      goalId, expectedGoalVersion: 1,
      contract: { title: "sample", category: "learning", desiredOutcome: "sample", definitionOfDone: "sample", deadline: null, weeklyMinutes: 60, constraints: null, motivation: null, "secret-property": "secret-value" },
      assumptions: [{ field: "secret-field", reason: "sample" }],
    }) }]);
    expect(result.argumentDiagnostics).toEqual([{
      toolName: "create_goal_contract_draft", status: "invalid_arguments",
      issues: [
        { path: "contract", code: "unrecognized_keys", rule: null },
        { path: "assumptions.[].field", code: "invalid_value", rule: null },
      ],
    }]);
    expect(JSON.stringify(result.argumentDiagnostics)).not.toContain("secret-");
  });

  it("shows only known plan field paths while redacting unknown task property names", async () => {
    const payload = {
      milestones: ["完成"], base: { planVersionId: null, goalVersion: 1 }, changeReason: "调整",
      tasks: [{ id: "11111111-1111-4111-8111-111111111111", title: "任务", action: "执行", doneCriteria: "可见结果", evidenceType: "user_declaration", estimateMinutes: "private-wrong-type", dueAt: null, dependencyIds: [], "private-task-field": "private-value" },
        { id: "22222222-2222-4222-8222-222222222222", title: "任务二", action: "执行", doneCriteria: "可见结果", evidenceType: "user_declaration", estimateMinutes: 20, dueAt: null, dependencyIds: [] },
        { id: "33333333-3333-4333-8333-333333333333", title: "任务三", action: "执行", doneCriteria: "可见结果", evidenceType: "user_declaration", estimateMinutes: 20, dueAt: null, dependencyIds: [] }],
    };
    const result = await observe([{ id: "plan-call", name: "propose_replan", argumentsJson: JSON.stringify({ goalId, payload }) }]);
    expect(result.argumentDiagnostics).toEqual([{ toolName: "propose_replan", status: "invalid_arguments", issues: [
      { path: "payload.tasks.[].estimateMinutes", code: "invalid_type", rule: null },
      { path: "payload.tasks.[]", code: "unrecognized_keys", rule: null },
    ] }]);
    expect(JSON.stringify(result.argumentDiagnostics)).not.toContain("private-");
  });

  it("marks unknown tools without copying an untrusted tool name into diagnostics", async () => {
    const result = await observe([{ id: "unknown", name: "secret-unknown-tool", argumentsJson: "{}" }]);
    expect(result.argumentDiagnostics).toEqual([{ toolName: "unknown", status: "unknown_tool", issues: [] }]);
  });

  it("reads historical call records without pretending diagnostics were captured", () => {
    const historical = { requestedModel: "synthetic-model", advertisedTools: [], proposedTools: [], latencyMs: 1, usage: null, errorCode: null };
    expect(ProviderCallSchema.parse(historical)).not.toHaveProperty("argumentDiagnostics");
  });
});
