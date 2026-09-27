import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { modelToolDefinitions, type ModelToolDefinition } from "./tool-registry";

export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export const ModelToolCallSchema = z.object({ id: z.string().min(1), name: z.string().min(1), argumentsJson: z.string() }).strict();
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;
export const ModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(ModelToolCallSchema).optional() }).strict(),
  z.object({ role: z.literal("tool"), content: z.string(), toolCallId: z.string().min(1) }).strict(),
]);
export type ModelMessage = z.infer<typeof ModelMessageSchema>;
const modelNames = new Set(modelToolDefinitions().map(tool => tool.name));
export const ModelToolDefinitionSchema: z.ZodType<ModelToolDefinition> = z.object({
  name: z.custom<ModelToolDefinition["name"]>(value => typeof value === "string" && modelNames.has(value as ModelToolDefinition["name"])),
  description: z.string().min(1), inputSchema: z.record(z.string(), z.json()),
}).strict();
export const ModelRequestSchema = z.object({
  model: z.string().trim().min(1), messages: z.array(ModelMessageSchema).min(1), tools: z.array(ModelToolDefinitionSchema),
}).strict().superRefine((request, context) => {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) context.addIssue({ code: "custom", message: "Tool result must match an unresolved preceding assistant call", path: ["messages", index] });
    } else {
      if (pending.size) context.addIssue({ code: "custom", message: "Assistant calls require all tool results before continuing", path: ["messages", index] });
      if (message.role === "assistant") for (const call of message.toolCalls ?? []) {
        if (seen.has(call.id)) context.addIssue({ code: "custom", message: "Tool call IDs must be unique", path: ["messages", index] });
        pending.add(call.id); seen.add(call.id);
      }
    }
  }
  if (pending.size) context.addIssue({ code: "custom", message: "Unresolved tool calls", path: ["messages"] });
  if (new Set(request.tools.map(tool => tool.name)).size !== request.tools.length)
    context.addIssue({ code: "custom", message: "Duplicate tool definitions", path: ["tools"] });
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;
export const ModelTurnSchema = z.object({
  text: z.string(), toolCalls: z.array(ModelToolCallSchema), usage: ModelUsageSchema, finishReason: z.string().min(1),
}).strict().superRefine((turn, context) => {
  if (new Set(turn.toolCalls.map(call => call.id)).size !== turn.toolCalls.length)
    context.addIssue({ code: "custom", message: "Duplicate tool call IDs", path: ["toolCalls"] });
});
export type ModelTurn = z.infer<typeof ModelTurnSchema>;
export interface ModelClient { complete(request: ModelRequest): Promise<ModelTurn>; }
/** Known billed counts survive invalid output; no provider body or hidden reasoning survives. */
export class ModelResponseError extends AppError {
  readonly usage: ModelUsage | null;
  constructor(usage: ModelUsage | null) {
    super("MODEL_RESPONSE_INVALID", 502, "Model returned an invalid response");
    this.usage = usage === null ? null : ModelUsageSchema.parse(usage);
  }
}
