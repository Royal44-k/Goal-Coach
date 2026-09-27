import { z } from "zod";
import { AppError, AppErrorCodeSchema, type AppErrorCode } from "@/core/errors/app-error";

const publicMessageSchema = z.string().trim().min(1);
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: AppErrorCodeSchema,
    message: publicMessageSchema,
  }).strict(),
}).strict();
const successEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
}).strict();
const apiEnvelopeSchema = z.discriminatedUnion("ok", [successEnvelopeSchema, errorEnvelopeSchema]);

export type UnknownApiOutcomeReason =
  | "network"
  | "aborted"
  | "unreadable_response"
  | "invalid_envelope"
  | "status_mismatch"
  | "invalid_success_data";

export class ReceivedApiError extends AppError {
  readonly kind = "received" as const;

  constructor(code: AppErrorCode, status: number, validatedPublicMessage: string) {
    super(code, status, validatedPublicMessage);
  }
}

export class UnknownApiOutcomeError extends Error {
  readonly name = "UnknownApiOutcomeError";
  readonly kind = "unknown" as const;

  constructor(
    public readonly reason: UnknownApiOutcomeReason,
    public readonly status?: number,
  ) {
    super("无法确认请求结果，请刷新当前状态后再决定是否继续。");
  }
}

export function isReceivedApiError(error: unknown): error is ReceivedApiError {
  return error instanceof ReceivedApiError;
}

export function isUnknownApiOutcomeError(error: unknown): error is UnknownApiOutcomeError {
  return error instanceof UnknownApiOutcomeError;
}

function unknown(reason: UnknownApiOutcomeReason, status?: number): UnknownApiOutcomeError {
  return new UnknownApiOutcomeError(reason, status);
}

async function request<T>(path: string, init: RequestInit, responseSchema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    const aborted = error instanceof DOMException
      ? error.name === "AbortError"
      : typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
    throw unknown(aborted ? "aborted" : "network");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unknown("unreadable_response", response.status);
  }

  const parsedEnvelope = apiEnvelopeSchema.safeParse(body);
  if (!parsedEnvelope.success) throw unknown("invalid_envelope", response.status);

  const envelope = parsedEnvelope.data;
  if (response.ok !== envelope.ok) throw unknown("status_mismatch", response.status);

  if (!envelope.ok) {
    if (envelope.error.code === "AUTH_REQUIRED" && typeof window !== "undefined") window.dispatchEvent(new Event("goal-coach-auth-required"));
    throw new ReceivedApiError(envelope.error.code, response.status, envelope.error.message);
  }

  const parsedData = responseSchema.safeParse(envelope.data);
  if (!parsedData.success) throw unknown("invalid_success_data", response.status);
  return parsedData.data;
}

export const apiClient = { request } as const;
