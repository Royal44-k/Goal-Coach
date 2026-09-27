import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { SettingsUpdateSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return apiResponse(request, (actor) => getServiceContainer().settings.get(actor.ownerId)); }
export async function PATCH(request: Request) { return apiResponse(request, async (actor) => { const input = SettingsUpdateSchema.parse(await jsonBody(request)); return getServiceContainer().settings.update(actor.ownerId, input); }); }
