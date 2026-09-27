import OpenAI from "openai";
import { expect, it, vi } from "vitest";
import { toSafeErrorResponse } from "@/core/errors/app-error";
import { loadDeepSeekConfig } from "../config/deepseek-config";
import { DeepSeekClient, type DeepSeekTransport, type DeepSeekClientFactory } from "./deepseek-client";
import { ModelResponseError, type ModelRequest } from "./model-contracts";
import { modelToolDefinitions } from "./tool-registry";

const secret = "synthetic-secret";
const request: ModelRequest = { model: "deepseek-flash", messages: [{ role: "user", content: "next" }], tools: modelToolDefinitions() };
const response = (finish_reason = "stop", tool_calls?: unknown) => ({
  id: "completion", object: "chat.completion", created: 1, model: request.model,
  choices: [{ index: 0, finish_reason, logprobs: null, message: { role: "assistant", content: tool_calls ? null : "reply", refusal: null, ...(tool_calls ? { tool_calls } : {}), reasoning_content: "hidden" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
function harness(value: unknown = response()) {
  const create = vi.fn<DeepSeekTransport["chat"]["completions"]["create"]>(async () => value);
  const factory = vi.fn<DeepSeekClientFactory>(() => ({ chat: { completions: { create } } }));
  const client = new DeepSeekClient(loadDeepSeekConfig({ DEEPSEEK_API_KEY: secret }), factory);
  return { client, create, factory };
}

it("sends nonstreaming disabled-thinking payload and projects visible reply", async () => {
  const { client, create, factory } = harness();
  await expect(client.complete(request)).resolves.toEqual({ text: "reply", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" });
  expect(factory.mock.calls[0][0]).toEqual({ apiKey: secret, baseURL: "https://api.deepseek.com", timeout: 45000, maxRetries: 0 });
  expect(create.mock.calls[0][0]).toEqual({ model: "deepseek-flash", messages: request.messages,
    stream: false, thinking: { type: "disabled" }, max_tokens: 4096,
    tools: request.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: "auto" });
  expect(JSON.stringify(create.mock.calls[0][0])).not.toMatch(/enable_thinking|max_completion_tokens|reasoning_content/);
});

it("omits tool fields for no-tool requests and honors configured pro model and output limit", async () => {
  const { create, factory } = harness();
  const client = new DeepSeekClient(loadDeepSeekConfig({ DEEPSEEK_API_KEY: secret, DEEPSEEK_MODEL: "deepseek-v4-pro", DEEPSEEK_MAX_OUTPUT_TOKENS: "128" }), factory);
  await client.complete({ ...request, model: "deepseek-v4-pro", tools: [] });
  expect(create.mock.calls[0][0]).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 128 });
  expect(create.mock.calls[0][0]).not.toHaveProperty("tools");
  expect(create.mock.calls[0][0]).not.toHaveProperty("tool_choice");
});

it("preserves tool calls and matched results for another turn", async () => {
  const calls = [{ id: "call-1", type: "function", function: { name: "get_goal", arguments: "{}" } }];
  const { client, create } = harness(response("tool_calls", calls));
  const first = await client.complete(request);
  expect(first).toEqual({ text: "", toolCalls: [{ id: "call-1", name: "get_goal", argumentsJson: "{}" }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "tool_calls" });
  await client.complete({ ...request, messages: [...request.messages, { role: "assistant", content: first.text, toolCalls: first.toolCalls }, { role: "tool", toolCallId: "call-1", content: "done" }] });
  expect(create.mock.calls[1][0].messages).toEqual([{ role: "user", content: "next" }, { role: "assistant", content: "", tool_calls: calls }, { role: "tool", tool_call_id: "call-1", content: "done" }]);
});

it("rejects absent credentials and invalid request before dispatch", async () => {
  expect(() => new DeepSeekClient(loadDeepSeekConfig({}), vi.fn())).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
  const { client, create } = harness();
  await expect(client.complete({ ...request, model: "deepseek-v4-pro" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(client.complete({ ...request, apiKey: "browser-value" } as never)).rejects.toBeDefined();
  expect(create).not.toHaveBeenCalled();
});

it.each(["length", "content_filter", "tool_calls", "stop"])("rejects unsafe termination %s while preserving valid billed usage", async reason => {
  const value = reason === "stop" ? response(reason, [{ id: "call-1", type: "function", function: { name: "get_goal", arguments: "{}" } }]) : response(reason);
  const { client } = harness(value);
  await expect(client.complete(request)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID", usage: { inputTokens: 10, outputTokens: 5 } });
});

it("rejects length even when a complete tool call could otherwise be executed", async () => {
  const calls = [{ id: "call-1", type: "function", function: { name: "get_goal", arguments: "{}" } }];
  const { client } = harness(response("length", calls));
  await expect(client.complete(request)).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID", usage: { inputTokens: 10, outputTokens: 5 } });
});

it.each([{}, { ...response(), usage: { prompt_tokens: -1, completion_tokens: 5 } }, { ...response(), choices: [] }, response("tool_calls", []), response("tool_calls", [{ id: "same", type: "function", function: { name: "get_goal", arguments: "{}" } }, { id: "same", type: "function", function: { name: "get_goal", arguments: "{}" } }])])("rejects malformed completion without exposing hidden reasoning", async value => {
  const { client } = harness(value);
  try { await client.complete(request); throw new Error("accepted"); }
  catch (error) {
    expect(error).toBeInstanceOf(ModelResponseError);
    expect(JSON.stringify(error)).not.toContain("hidden");
  }
});

it.each([[401, "MODEL_AUTH_FAILED"], [403, "MODEL_AUTH_FAILED"], [402, "MODEL_BALANCE_INSUFFICIENT"], [400, "MODEL_UNAVAILABLE"], [404, "MODEL_UNAVAILABLE"], [422, "MODEL_UNAVAILABLE"], [500, "MODEL_UNAVAILABLE"], [429, "MODEL_RATE_LIMITED"]] as const)("maps HTTP %i to safe %s", async (status, code) => {
  const { client, create } = harness();
  create.mockRejectedValueOnce(OpenAI.APIError.generate(status, { error: { message: `body-${secret}` } }, `body-${secret}`, new Headers()));
  try { await client.complete(request); throw new Error("accepted"); }
  catch (error) {
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(toSafeErrorResponse(error))).not.toContain(secret);
  }
});

it.each([[new OpenAI.APIConnectionError({ message: secret }), "MODEL_UNAVAILABLE"], [new OpenAI.APIConnectionTimeoutError({ message: secret }), "MODEL_TIMEOUT"]] as const)("maps SDK connection failure to %s", async (error, code) => {
  const { client, create } = harness(); create.mockRejectedValueOnce(error);
  await expect(client.complete(request)).rejects.toMatchObject({ code });
});
