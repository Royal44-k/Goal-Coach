import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { AppError } from "@/core/errors/app-error";
import { requireDeepSeekConfig, type DeepSeekConfig } from "../config/deepseek-config";
import { ModelRequestSchema, ModelResponseError, type ModelClient, type ModelRequest, type ModelTurn } from "./model-contracts";
import { projectChatResponse, toChatMessages, toChatTools } from "./openai-chat-protocol";

export type DeepSeekCompletionRequest = ChatCompletionCreateParamsNonStreaming & { thinking: { type: "disabled" }; max_tokens: number };
export type DeepSeekTransport = { chat: { completions: { create(input: DeepSeekCompletionRequest): PromiseLike<unknown> } } };
export type DeepSeekClientFactory = (options: { apiKey: string; baseURL: string; timeout: number; maxRetries: number }) => DeepSeekTransport;

export class DeepSeekClient implements ModelClient {
  private readonly client: DeepSeekTransport;
  private readonly config: DeepSeekConfig & { apiKey: string };

  constructor(config: DeepSeekConfig, factory: DeepSeekClientFactory = options => new OpenAI(options)) {
    this.config = requireDeepSeekConfig(config);
    this.client = factory({ apiKey: this.config.apiKey, baseURL: this.config.baseURL, timeout: 45_000, maxRetries: 0 });
  }

  async complete(input: ModelRequest): Promise<ModelTurn> {
    const request = ModelRequestSchema.parse(input);
    if (request.model !== this.config.model) throw new AppError("VALIDATION_ERROR", 400, "Requested model is not pinned");
    let raw: unknown;
    try {
      raw = await this.client.chat.completions.create({ model: request.model, messages: toChatMessages(request.messages),
        stream: false, thinking: { type: "disabled" }, max_tokens: this.config.maxOutputTokens,
        ...(request.tools.length ? { tools: toChatTools(request.tools), tool_choice: "auto" as const } : {}) });
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionTimeoutError) throw new AppError("MODEL_TIMEOUT", 504, "Model request timed out");
      if (error instanceof OpenAI.APIConnectionError) throw new AppError("MODEL_UNAVAILABLE", 503, "Model connection failed");
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401 || error.status === 403) throw new AppError("MODEL_AUTH_FAILED", 502, "Model authentication failed");
        if (error.status === 402) throw new AppError("MODEL_BALANCE_INSUFFICIENT", 503, "Model account balance is insufficient");
        if (error.status === 429) throw new AppError("MODEL_RATE_LIMITED", 503, "Model provider rate limit reached");
        throw new AppError("MODEL_UNAVAILABLE", 503, "Model provider is unavailable");
      }
      throw new AppError("MODEL_UNAVAILABLE", 503, "Model request failed");
    }
    const turn = projectChatResponse(raw);
    if ((turn.finishReason === "stop" && turn.toolCalls.length === 0) || (turn.finishReason === "tool_calls" && turn.toolCalls.length > 0)) return turn;
    throw new ModelResponseError(turn.usage);
  }
}
