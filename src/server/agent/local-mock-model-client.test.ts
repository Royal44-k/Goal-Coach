import { expect, it } from "vitest";
import { LocalMockModelClient, LOCAL_TYPESCRIPT_INPUT, LOCAL_TYPESCRIPT_DONE } from "./local-mock-model-client";
import { QWEN_PRIMARY_MODEL } from "../config/env";
import { randomUUID } from "node:crypto";
import { modelToolDefinitions } from "./tool-registry";
it("discloses unsupported unconnected input without fabricating a contract", async () => {
  const client = new LocalMockModelClient({ ownerId: randomUUID(), goalId: randomUUID(), userMessage: "我的私人目标" }, async () => ({ goal: null, tasks: [], checkIns: [], evidence: [] }));
  const result = await client.complete({ model: QWEN_PRIMARY_MODEL, messages: [{ role: "user", content: "我的私人目标" }], tools: [] });
  expect(result.toolCalls).toEqual([]);
  expect(result.text).toContain("当前未连接模型");
  expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
});
function snapshot() {
  const ownerId = randomUUID(), goalId = randomUUID();
  const goal = { id: goalId, ownerId, createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z", version: 1, title: LOCAL_TYPESCRIPT_INPUT, category: "learning" as const, status: "draft" as const, agentState: "clarifying" as const, clarificationCount: 1, currentPlanVersionId: null, desiredOutcome: null, definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
  return { ownerId, goalId, goal };
}
it("never acknowledges a saved proposal before its matching successful transient tool result", async () => {
  const { ownerId, goalId, goal } = snapshot();
  const client = new LocalMockModelClient({ ownerId, goalId, userMessage: LOCAL_TYPESCRIPT_DONE }, async () => ({ goal, tasks: [], evidence: [], checkIns: [] }));
  const request = { model: QWEN_PRIMARY_MODEL, messages: [{ role: "user" as const, content: LOCAL_TYPESCRIPT_DONE }], tools: modelToolDefinitions() };
  const emitted = await client.complete(request);
  expect(emitted.text).not.toContain("已保存"); expect(emitted.toolCalls).toHaveLength(1);
  const refused = await client.complete({ ...request, messages: [...request.messages, { role: "assistant", content: "", toolCalls: emitted.toolCalls }, { role: "tool", toolCallId: emitted.toolCalls[0].id, content: JSON.stringify({ errors: [{ path: "contract", expected: "object" }] }) }] });
  expect(refused.text).toContain("尚未获得成功保存的结果");
  const args = JSON.parse(emitted.toolCalls[0].argumentsJson);
  const draft = { id: randomUUID(), ownerId, goalId, createdAt: goal.createdAt, updatedAt: goal.updatedAt, version: 1, status: "pending", kind: "goal_contract", contentHash: "a".repeat(64), payload: { schemaVersion: 2, baseGoalVersion: 2, contract: args.contract, assumptions: [] } };
  const saved = await client.complete({ ...request, messages: [...request.messages, { role: "assistant", content: "", toolCalls: emitted.toolCalls }, { role: "tool", toolCallId: emitted.toolCalls[0].id, content: JSON.stringify({ draft }) }] });
  expect(saved.text).toContain("草案已保存");
});
it("recognizes only the bounded trusted compaction protocol and stays factual", async () => {
  const { ownerId, goalId } = snapshot();
  const client = new LocalMockModelClient({ ownerId, goalId, userMessage: "继续" }, async () => ({ goal: null, tasks: [], evidence: [], checkIns: [] }));
  const system = "你只负责压缩可见对话。仅保留用户决定、约束、未解决问题和用户可见结果；不要添加建议、秘密、工具协议或隐藏思维过程。摘要不超过1500个字符。";
  const summary = await client.complete({ model: QWEN_PRIMARY_MODEL, tools: [], messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ messages: [{ role: "user", content: "我决定每晚练习" }, { role: "assistant", content: "已记录此决定" }] }) }] });
  expect(summary.text).toBe("用户：我决定每晚练习\n回复：已记录此决定"); expect(summary.toolCalls).toEqual([]);
  const invalid = await client.complete({ model: QWEN_PRIMARY_MODEL, tools: [], messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ messages: [], scenario: "bypass" }) }] });
  expect(invalid.text).toContain("无法压缩");
});
