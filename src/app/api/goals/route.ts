import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { CreateGoalSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return apiResponse(request, (actor) => getServiceContainer().goals.list(actor.ownerId)); }
export async function POST(request: Request) { return apiResponse(request, async (actor) => { const input = CreateGoalSchema.parse(await jsonBody(request)); return getServiceContainer().goals.create(actor.ownerId, input); }); }
