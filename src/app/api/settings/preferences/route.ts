import { z } from "zod";
import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { PreferencesUpdateSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return apiResponse(request, (actor) => getServiceContainer().settings.getPreferences(actor.ownerId)); }
export async function PATCH(request: Request) { return apiResponse(request, async (actor) => { const input = PreferencesUpdateSchema.parse(await jsonBody(request)); return getServiceContainer().settings.updatePreferences(actor.ownerId, input); }); }
export async function DELETE(request: Request) { return apiResponse(request, async (actor) => { z.object({}).strict().parse(await jsonBody(request)); return getServiceContainer().settings.clearPreferences(actor.ownerId); }); }
