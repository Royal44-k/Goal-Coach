import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { expect, it, vi } from "vitest";
import { loadServerEnv } from "../config/env";
import { QwenClient, type QwenTransport, type QwenClientFactory } from "./qwen-client";
import { modelToolDefinitions } from "./tool-registry";
import { ModelResponseError, type ModelRequest } from "./model-contracts";

const env = () => loadServerEnv({ DASHSCOPE_API_KEY: randomUUID(), DASHSCOPE_BASE_URL: "https://example.invalid/v1" });
const request: ModelRequest = { model: "qwen3.7-flash-2026-07-15", messages: [{ role: "user", content: "下一步" }], tools: modelToolDefinitions() };
function response() {
  return { id: "completion", object: "chat.completion", created: 1, model: request.model,
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "答复", refusal: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
function harness(value: unknown = response()) {
  const create = vi.fn<QwenTransport["chat"]["completions"]["create"]>(async () => value);
  const factory = vi.fn<QwenClientFactory>(() => ({ chat: { completions: { create } } }));
  const client = new QwenClient(env(), factory);
  return { client, create, factory };
}
it("constructs a bounded server client and maps pinned model, current messages and unprotected tools", async () => {
  const { client, create, factory } = harness();
  await expect(client.complete(request)).resolves.toEqual({ text: "答复", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" });
  expect(factory.mock.calls[0][0]).toMatchObject({ baseURL: "https://example.invalid/v1", timeout: 45000, maxRetries: 0 });
  expect(create.mock.calls[0][0]).toEqual({ model: request.model, messages: request.messages,
    tools: request.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: "auto",
    enable_thinking: false, max_completion_tokens: 2048 });
  expect(create.mock.calls[0][0]).not.toHaveProperty("response_format");
});
it("uses the validated per-call output limit without enabling provider reasoning", async () => {
  const create = vi.fn<QwenTransport["chat"]["completions"]["create"]>(async () => response());
  const client = new QwenClient(loadServerEnv({ DASHSCOPE_API_KEY: randomUUID(), DASHSCOPE_BASE_URL: "https://example.invalid/v1", QWEN_MAX_OUTPUT_TOKENS: "4096" }), () => ({ chat: { completions: { create } } }));
  await client.complete(request);
  expect(create.mock.calls[0][0]).toMatchObject({ enable_thinking: false, max_completion_tokens: 4096 });
});
it("omits tools and tool choice for compaction or states with no allowed tools", async () => {
  const { client, create } = harness();
  await client.complete({ ...request, tools: [] });
  expect(create.mock.calls[0][0]).not.toHaveProperty("tools");
  expect(create.mock.calls[0][0]).not.toHaveProperty("tool_choice");
});
it.each([1, 2])("preserves the preceding assistant calls and all %i results including parameter repair", async count => {
  const calls = Array.from({ length: count }, (_, index) => ({ id: `call-${index}`, type: "function", function: { name: "get_goal", arguments: index ? '{"goalId":"bad"}' : "{}" } }));
  const value = response();
  const { client, create } = harness({ ...value, choices: [{ ...value.choices[0], finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls, reasoning_content: "must be discarded" } }] });
  const first = await client.complete(request);
  expect(first).not.toHaveProperty("reasoning_content");
  const continued: ModelRequest = { ...request, messages: [...request.messages, { role: "assistant", content: first.text, toolCalls: first.toolCalls }, ...first.toolCalls.map(call => ({ role: "tool" as const, toolCallId: call.id, content: '{"code":"VALIDATION_ERROR","message":"修复 goalId"}' }))] };
  await client.complete(continued);
  expect(create.mock.calls[1][0]).toMatchObject({ messages: [request.messages[0], { role: "assistant", content: "", tool_calls: calls }, ...calls.map(call => ({ role: "tool", tool_call_id: call.id, content: '{"code":"VALIDATION_ERROR","message":"修复 goalId"}' }))] });
});
it("fails closed on absent credentials even with a fake client and env provider mock", () => {
  const factory = vi.fn();
  expect(() => new QwenClient(loadServerEnv({}), factory)).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
  expect(factory).not.toHaveBeenCalled();
});
it("rejects model overrides and browser key fields before provider dispatch", async () => {
  const { client, create } = harness();
  await expect(client.complete({ ...request, model: "other" })).rejects.toBeDefined();
  await expect(client.complete({ ...request, apiKey: "browser-value" } as never)).rejects.toBeDefined();
  expect(create).not.toHaveBeenCalled();
});
it("transports either pinned model while leaving fallback admission to the agent loop", async () => {
  const { client, create } = harness();
  const fallback = { ...request, model: "qwen3.7-plus-2026-05-26" };
  await expect(client.complete(fallback)).resolves.toMatchObject({ text: "答复" });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0].model).toBe("qwen3.7-plus-2026-05-26");
});
it.each([{}, { ...response(), usage: undefined }, { ...response(), choices: [] }, { ...response(), usage: { prompt_tokens: -1, completion_tokens: 0 } }, { ...response(), choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] }])("rejects invalid provider responses without retrying", async value => {
  const { client, create } = harness(value);
  await expect(client.complete(request)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  expect(create).toHaveBeenCalledTimes(1);
});
it("maps SDK timeout and generic upstream failures without leaking or retrying", async () => {
  for (const error of [new OpenAI.APIConnectionTimeoutError(), new Error("private provider body")]) {
    const { client, create } = harness(); create.mockRejectedValueOnce(error);
    await expect(client.complete(request)).rejects.toMatchObject({ code: error instanceof OpenAI.APIConnectionTimeoutError ? "MODEL_TIMEOUT" : "MODEL_RESPONSE_INVALID" });
    expect(create).toHaveBeenCalledTimes(1);
  }
});
it.each([
  [401, "MODEL_AUTH_FAILED"],
  [403, "MODEL_AUTH_FAILED"],
  [404, "MODEL_UNAVAILABLE"],
  [429, "MODEL_RATE_LIMITED"],
] as const)("classifies provider HTTP %i by status without exposing its message", async (status, code) => {
  const secret = `private-${status}`;
  const { client, create } = harness();
  create.mockRejectedValueOnce(OpenAI.APIError.generate(status, { error: { message: secret } }, secret, new Headers()));
  try { await client.complete(request); throw new Error("accepted"); }
  catch (error) {
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain(secret);
  }
  expect(create).toHaveBeenCalledTimes(1);
});
it("classifies connection failures as unavailable while preserving the timeout branch", async () => {
  for (const [error, code] of [
    [new OpenAI.APIConnectionError({ message: "private connection detail" }), "MODEL_UNAVAILABLE"],
    [new OpenAI.APIConnectionTimeoutError({ message: "private timeout detail" }), "MODEL_TIMEOUT"],
  ] as const) {
    const { client, create } = harness();
    create.mockRejectedValueOnce(error);
    await expect(client.complete(request)).rejects.toMatchObject({ code });
    expect(create).toHaveBeenCalledTimes(1);
  }
});
it("exposes known billed usage on malformed message or tools with no raw response retained", async () => {
  for (const message of [{ role: "assistant", content: 3 }, { role: "assistant", content: null, tool_calls: [{ id: "a", type: "custom", custom: {} }] }]) {
    const { client } = harness({ ...response(), choices: [{ finish_reason: "tool_calls", message: { ...message, reasoning_content: "private reasoning" } }] });
    try { await client.complete(request); throw new Error("accepted"); }
    catch (error) {
      expect(error).toBeInstanceOf(ModelResponseError);
      expect(error).toMatchObject({ code: "MODEL_RESPONSE_INVALID", usage: { inputTokens: 10, outputTokens: 5 } });
      expect(JSON.stringify(error)).not.toContain("private reasoning");
      expect(error).not.toHaveProperty("cause");
    }
  }
});
