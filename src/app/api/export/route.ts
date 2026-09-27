import { apiResponse } from "@/app/api/_shared/api-response";
import { getServiceContainer } from "@/server/services/service-container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return apiResponse(request, (actor) => getServiceContainer().data.export(actor.ownerId)); }
