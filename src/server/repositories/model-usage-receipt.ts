import { z } from "zod";
import { type Operation } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import { contentHash } from "../security/canonical-json";

export const ModelUsageReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("model_usage"), attemptId: z.uuid(), day: z.iso.date(),
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ModelUsageReceipt = z.infer<typeof ModelUsageReceiptSchema>;
/** An internal Operation projection, never a model tool or a content-bearing audit. */
export function parseModelUsageReceipt(operation: Operation): ModelUsageReceipt {
  const parsed = ModelUsageReceiptSchema.safeParse(operation.result);
  if (!parsed.success || operation.goalId !== null || operation.toolName !== "record_model_usage"
    || operation.status !== "succeeded" || operation.operationId !== `model-usage:${parsed.data.attemptId}`
    || operation.parameterHash !== contentHash(parsed.data)) {
    throw new AppError("VALIDATION_ERROR", 400, "Invalid model usage receipt");
  }
  return parsed.data;
}
