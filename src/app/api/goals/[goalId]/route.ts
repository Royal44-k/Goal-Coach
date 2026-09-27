import { z } from "zod";
import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { ChangeStatusSchema, DeleteGoalSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ goalId: string }> };
export async function GET(request: Request, ctx: Context) { return apiResponse(request, async (actor) => { const { goalId } = z.object({ goalId: z.uuid() }).strict().parse(await ctx.params); return getServiceContainer().goals.getWorkspace(actor.ownerId, goalId); }); }
export async function PATCH(request: Request, ctx: Context) { return apiResponse(request, async (actor) => { const { goalId } = z.object({ goalId: z.uuid() }).strict().parse(await ctx.params); const input = ChangeStatusSchema.parse(await jsonBody(request)); return getServiceContainer().goals.changeStatus(actor.ownerId, goalId, input); }); }
export async function DELETE(request: Request, ctx: Context) { return apiResponse(request, async (actor) => { const { goalId } = z.object({ goalId: z.uuid() }).strict().parse(await ctx.params); const input = DeleteGoalSchema.parse(await jsonBody(request)); return getServiceContainer().goals.remove(actor.ownerId, goalId, input); }); }
