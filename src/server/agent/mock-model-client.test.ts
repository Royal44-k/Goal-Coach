import { expect, it } from "vitest";
import { MockModelClient } from "./mock-model-client";
import { ModelMessageSchema, ModelRequestSchema, ModelTurnSchema } from "./model-contracts";

const request = { model: "mock", messages: [{ role: "user" as const, content: "你好" }], tools: [] };
const turn = { text: "请告诉我截止日期", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" };
it("consumes queued turns once in order and fails stably on exhaustion", async () => {
  const mock = new MockModelClient([turn, { ...turn, text: "第二条" }]);
  await expect(mock.complete(request)).resolves.toMatchObject({ text: "请告诉我截止日期" });
  await expect(mock.complete(request)).resolves.toMatchObject({ text: "第二条" });
  await expect(mock.complete(request)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID", internalMessage: "Mock model queue exhausted" });
});
it("validates requests before consuming a queued turn", async () => {
  const mock = new MockModelClient([turn]);
  await expect(mock.complete({ ...request, messages: [{ role: "tool", content: "bad" }] } as never)).rejects.toBeDefined();
  await expect(mock.complete(request)).resolves.toMatchObject({ text: turn.text });
});
it.each([
  { role: "tool", content: "x" },
  { role: "user", content: "x", toolCallId: "call" },
  { role: "system", content: "x", toolCalls: [] },
  { role: "assistant", content: "x", reasoning: "private" },
])("rejects invalid role-specific transient messages", message => {
  expect(ModelMessageSchema.safeParse(message).success).toBe(false);
});
it("rejects unpaired, duplicate and interrupted tool exchange requests", () => {
  const call = { id: "call", name: "get_goal", argumentsJson: "{}" };
  const assistant = { role: "assistant", content: "", toolCalls: [call] };
  const result = { role: "tool", content: "{}", toolCallId: "call" };
  for (const messages of [[result], [assistant], [assistant, { ...result, toolCallId: "other" }], [assistant, result, result], [assistant, request.messages[0], result], [{ ...assistant, toolCalls: [call, call] }, result]]) {
    expect(ModelRequestSchema.safeParse({ ...request, messages }).success).toBe(false);
  }
});
it("rejects hidden reasoning and invalid counters in provider-neutral turns", () => {
  expect(ModelTurnSchema.safeParse({ ...turn, reasoning: "private" }).success).toBe(false);
  expect(ModelTurnSchema.safeParse({ ...turn, usage: { inputTokens: -1, outputTokens: 5 } }).success).toBe(false);
});
