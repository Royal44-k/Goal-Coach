import { z } from "zod";
import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { TaskUpdateBodySchema, DeleteTaskSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ goalId: string; taskId: string }> };
export async function PATCH(request: Request, ctx: Context) { return apiResponse(request, async (actor) => { const { goalId, taskId } = z.object({ goalId: z.uuid(), taskId: z.uuid() }).strict().parse(await ctx.params); const input = TaskUpdateBodySchema.parse(await jsonBody(request)); return getServiceContainer().tasks.update(actor.ownerId, taskId, { ...input, goalId }, "ui_explicit"); }); }
export async function DELETE(request: Request, ctx: Context) { return apiResponse(request, async (actor) => { const { goalId, taskId } = z.object({ goalId: z.uuid(), taskId: z.uuid() }).strict().parse(await ctx.params); const input = DeleteTaskSchema.omit({ goalId: true }).parse(await jsonBody(request)); return getServiceContainer().tasks.remove(actor.ownerId, taskId, { ...input, goalId }); }); }
