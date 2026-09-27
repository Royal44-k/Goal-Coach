import { authResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getAuthService } from "@/server/auth/auth-container";
import { RegisterSchema, loginResponse, requireInviteMode } from "../_shared";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return authResponse(request, async () => { requireInviteMode(); return loginResponse(await getAuthService().register(RegisterSchema.parse(await jsonBody(request)))); });
}
