import { AppError } from "@/core/errors/app-error";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { loadAuthConfig } from "./auth-config";
import { getAuthService } from "./auth-container";
import type { AuthActor } from "./auth-contracts";

export const SESSION_COOKIE = "goal_coach_session";
export function requestSessionToken(request: Request): string {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return "";
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
}
export function requireRequestActor(request: Request): AuthActor {
  if (loadAuthConfig().mode === "local") return { ownerId: LOCAL_OWNER_ID, username: "本机用户", role: "member" };
  const token = requestSessionToken(request);
  const actor = token ? getAuthService().authenticate(token) : null;
  if (!actor) throw new AppError("AUTH_REQUIRED", 401, "Session is required");
  return actor;
}
export function sessionCookie(token: string, expiresAt: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${loadAuthConfig().secureCookies ? "; Secure" : ""}`;
}
