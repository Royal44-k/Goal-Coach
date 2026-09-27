import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { ModelResponseError, ModelTurnSchema, ModelUsageSchema, type ModelRequest, type ModelTurn } from "./model-contracts";

const UsageEnvelope = z.object({ usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }) });
// Select visible protocol fields only; provider-specific reasoning is discarded.
const ResponseSchema = z.object({ choices: z.array(z.object({
  finish_reason: z.string().min(1),
  message: z.object({ role: z.literal("assistant"), content: z.string().nullable(),
    tool_calls: z.array(z.object({ id: z.string().min(1), type: z.literal("function"),
      function: z.object({ name: z.string().min(1), arguments: z.string() }) })).optional(),
  }).refine(message => message.content !== null || (message.tool_calls?.length ?? 0) > 0),
})).length(1) });

export function toChatMessages(messages: ModelRequest["messages"]): ChatCompletionMessageParam[] {
  return messages.map(message => {
    if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
    if (message.role === "assistant" && message.toolCalls?.length) return { role: "assistant", content: message.content,
      tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.argumentsJson } })) };
    return { role: message.role, content: message.content };
  });
}

export function toChatTools(tools: ModelRequest["tools"]) {
  return tools.map(tool => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

export function projectChatResponse(raw: unknown): ModelTurn {
  const envelope = UsageEnvelope.safeParse(raw);
  const parsedUsage = ModelUsageSchema.safeParse(envelope.success ? { inputTokens: envelope.data.usage.prompt_tokens, outputTokens: envelope.data.usage.completion_tokens } : null);
  const usage = parsedUsage.success ? parsedUsage.data : null;
  const parsed = ResponseSchema.safeParse(raw);
  if (!usage || !parsed.success) throw new ModelResponseError(usage);
  const choice = parsed.data.choices[0];
  const turn = ModelTurnSchema.safeParse({ text: choice.message.content ?? "",
    toolCalls: (choice.message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, argumentsJson: call.function.arguments })),
    usage, finishReason: choice.finish_reason });
  if (!turn.success) throw new ModelResponseError(usage);
  return turn.data;
}
