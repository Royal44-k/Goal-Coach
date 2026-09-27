import { z } from "zod";
import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getAuthService } from "@/server/auth/auth-container";
import { requireInviteMode } from "@/app/api/auth/_shared";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return apiResponse(request, async actor => { requireInviteMode(); return getAuthService().listInvites(actor); }); }
export async function POST(request: Request) { return apiResponse(request, async actor => { requireInviteMode(); z.object({}).strict().parse(await jsonBody(request)); return getAuthService().createInvite(actor); }); }
export async function DELETE(request: Request) { return apiResponse(request, async actor => { requireInviteMode(); const { id } = z.object({ id: z.uuid() }).strict().parse(await jsonBody(request)); getAuthService().revokeInvite(actor, id); }); }
