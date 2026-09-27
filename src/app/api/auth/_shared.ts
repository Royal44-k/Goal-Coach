import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { loadAuthConfig } from "@/server/auth/auth-config";
import type { AuthSession } from "@/server/auth/auth-contracts";
import { sessionCookie } from "@/server/auth/request-identity";
export const LoginSchema = z.object({ username: z.string().max(256), password: z.string().max(128) }).strict();
export const RegisterSchema = LoginSchema.extend({ inviteToken: z.string().max(128) });
export function requireInviteMode() {
  if (loadAuthConfig().mode !== "invite") throw new AppError("AUTH_FORBIDDEN", 403, "Account management is unavailable in local mode");
}
export function loginResponse(session: AuthSession): Response {
  return Response.json({ ok: true, data: { actor: session.actor } }, { headers: { "Set-Cookie": sessionCookie(session.token, session.expiresAt) } });
}
