import { authResponse } from "@/app/api/_shared/api-response";
import { AppError } from "@/core/errors/app-error";
import { loadAuthConfig } from "@/server/auth/auth-config";
import { requireRequestActor } from "@/server/auth/request-identity";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return authResponse(request, async () => {
    const { mode } = loadAuthConfig();
    try { return { mode, actor: requireRequestActor(request) }; }
    catch (error) { if (error instanceof AppError && error.code === "AUTH_REQUIRED") return { mode, actor: null }; throw error; }
  });
}
