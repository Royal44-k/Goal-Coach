import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { AppError } from "@/core/errors/app-error";
import { requireQwenConfig, type ServerEnv } from "../config/env";
import { ModelRequestSchema, ModelResponseError, type ModelClient, type ModelRequest, type ModelTurn } from "./model-contracts";
import { projectChatResponse, toChatMessages, toChatTools } from "./openai-chat-protocol";

export type QwenCompletionRequest = ChatCompletionCreateParamsNonStreaming & {
  enable_thinking: false;
  max_completion_tokens: number;
};
export type QwenTransport = { chat: { completions: { create(input: QwenCompletionRequest): PromiseLike<unknown> } } };
export type QwenClientFactory = (options: { apiKey: string; baseURL: string; timeout: number; maxRetries: number }) => QwenTransport;

export class QwenClient implements ModelClient {
  private readonly client: QwenTransport;
  private readonly allowedModels: ReadonlySet<string>;
  private readonly maxOutputTokens: number;
  constructor(env: ServerEnv, factory: QwenClientFactory = options => new OpenAI(options)) {
    const config = requireQwenConfig(env);
    this.allowedModels = new Set([config.model, config.fallbackModel]);
    this.maxOutputTokens = config.qwenMaxOutputTokens;
    this.client = factory({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 45_000, maxRetries: 0 });
  }
  async complete(input: ModelRequest): Promise<ModelTurn> {
    const request = ModelRequestSchema.parse(input);
    // The agent loop owns the persisted fallback policy and all retry limits.
    if (!this.allowedModels.has(request.model))
      throw new AppError("VALIDATION_ERROR", 400, "Requested model is not pinned");
    let raw: unknown;
    try {
      raw = await this.client.chat.completions.create({ model: request.model, messages: toChatMessages(request.messages),
        enable_thinking: false, max_completion_tokens: this.maxOutputTokens,
        ...(request.tools.length ? { tools: toChatTools(request.tools), tool_choice: "auto" as const } : {}) });
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionTimeoutError) throw new AppError("MODEL_TIMEOUT", 504, "Model request timed out");
      if (error instanceof OpenAI.APIConnectionError) throw new AppError("MODEL_UNAVAILABLE", 503, "Model connection failed");
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401 || error.status === 403) throw new AppError("MODEL_AUTH_FAILED", 502, "Model authentication failed");
        if (error.status === 404) throw new AppError("MODEL_UNAVAILABLE", 503, "Configured model is unavailable");
        if (error.status === 429) throw new AppError("MODEL_RATE_LIMITED", 503, "Model provider rate limit reached");
      }
      throw new ModelResponseError(null);
    }
    return projectChatResponse(raw);
  }
}
