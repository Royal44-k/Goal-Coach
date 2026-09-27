import { z } from "zod";
import { AppError, toSafeErrorResponse, type SafeErrorResponse } from "@/core/errors/app-error";
import { AgentTurnError, AgentTurnFailureSchema } from "@/server/agent/agent-turn-error";
import { assertLocalMutationOrigin } from "@/server/security/origin-guard";
import { requireRequestActor } from "@/server/auth/request-identity";
import type { AuthActor } from "@/server/auth/auth-contracts";
export function toSafeAgentTurnErrorResponse(error: unknown): SafeErrorResponse {
  const safe = toSafeErrorResponse(error);
  if (error instanceof AgentTurnError) {
    const failure = AgentTurnFailureSchema.safeParse({ code: error.code, status: error.status, state: error.turn.state, persistedChange: error.turn.persistedChange });
    if (failure.success && failure.data.persistedChange) return { ...safe, message: safe.message + " 本次执行中已有更改保存成功，请先刷新查看当前状态。" };
  }
  return safe;
}
export async function jsonBody(request: Request): Promise<unknown> {
  try { return JSON.parse(await boundedBody(request)); }
  catch { throw new AppError("VALIDATION_ERROR", 400, "Invalid JSON body"); }
}
const bodies = new WeakMap<Request, string>();
async function boundedBody(request: Request): Promise<string> {
  const cached = bodies.get(request); if (cached !== undefined) return cached;
  const max = 256 * 1024;
  const oversized = () => new AppError("VALIDATION_ERROR", 413, "Request body exceeds limit");
  if (Number(request.headers.get("content-length")) > max) throw oversized();
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { void reader.cancel().catch(() => undefined); throw oversized(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); bodies.set(request, body); return body;
}
async function checkedResponse(request: Request, action: () => Promise<unknown>, agentTurn = false): Promise<Response> {
  try {
    assertLocalMutationOrigin(request);
    z.object({}).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    await boundedBody(request);
    const data = await action();
    if (data instanceof Response) { data.headers.set("Cache-Control", "no-store"); return data; }
    return Response.json({ ok: true, data: data ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (raw) {
    const error = raw instanceof z.ZodError ? new AppError("VALIDATION_ERROR", 400, "Invalid request or stored contract") : raw;
    return Response.json({ ok: false, error: agentTurn ? toSafeAgentTurnErrorResponse(error) : toSafeErrorResponse(error) }, { status: error instanceof AppError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
export function apiResponse(request: Request, action: (actor: AuthActor) => Promise<unknown>, agentTurn = false): Promise<Response> {
  return checkedResponse(request, () => action(requireRequestActor(request)), agentTurn);
}
/** Only the four auth routes use this boundary; business routes always use apiResponse. */
export function authResponse(request: Request, action: () => Promise<unknown>): Promise<Response> {
  return checkedResponse(request, action);
}
