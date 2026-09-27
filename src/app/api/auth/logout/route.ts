import { z } from "zod";
import { authResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getAuthService } from "@/server/auth/auth-container";
import { requestSessionToken, sessionCookie } from "@/server/auth/request-identity";
import { requireInviteMode } from "../_shared";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return authResponse(request, async () => {
    requireInviteMode(); z.object({}).strict().parse(await jsonBody(request));
    const token = requestSessionToken(request); if (token) getAuthService().logout(token);
    return Response.json({ ok: true, data: null }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
  });
}
