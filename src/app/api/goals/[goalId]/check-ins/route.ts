import { z } from "zod";
import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { CheckInInputSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ goalId: string }> };
export async function POST(request: Request, ctx: Context) { return apiResponse(request, async (actor) => { const { goalId } = z.object({ goalId: z.uuid() }).strict().parse(await ctx.params); const input = CheckInInputSchema.parse(await jsonBody(request)); return getServiceContainer().tasks.recordCheckIn(actor.ownerId, goalId, input); }); }
