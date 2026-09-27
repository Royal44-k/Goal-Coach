import type { EvidenceType } from "@/core/domain/contracts";
import { z } from "zod";

const text = z.string().trim().min(1);
export const EvidenceSubmissionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text }).strict(),
  z.object({ type: z.literal("check_answer"), text }).strict(),
  z.object({ type: z.literal("user_declaration"), text }).strict(),
  z.object({ type: z.literal("file_metadata"), fileName: text, fileSize: z.number().int().nonnegative(), mimeType: text }).strict(),
]);
export type EvidenceSubmission = z.infer<typeof EvidenceSubmissionSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateEvidenceShape(type: EvidenceType, value: unknown): boolean {
  if (!isRecord(value) || Object.hasOwn(value, "type")) return false;
  return EvidenceSubmissionSchema.safeParse({ type, ...value }).success;
}
