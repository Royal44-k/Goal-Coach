import { z } from "zod";
import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { RejectReplanSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ goalId: string; draftId: string }> };
export async function POST(request: Request, ctx: Context) { return apiResponse(request, async (actor) => { const target = z.object({ goalId: z.uuid(), draftId: z.uuid() }).strict().parse(await ctx.params); const input = RejectReplanSchema.omit({ goalId: true, draftId: true }).parse(await jsonBody(request)); return getServiceContainer().plans.rejectReplan(actor.ownerId, { ...target, ...input }); }); }
