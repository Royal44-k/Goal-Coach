import { apiResponse, jsonBody } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

import { ApproveSchema } from "@/server/services/service-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return apiResponse(request, async (actor) => { const input = ApproveSchema.parse(await jsonBody(request)); return getServiceContainer().approvals.approve(actor.ownerId, input); }); }
