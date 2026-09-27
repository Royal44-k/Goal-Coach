import { apiResponse } from "@/app/api/_shared/api-response";
import { getModelReadiness } from "@/server/agent/model-readiness";
import { loadServerEnv } from "@/server/config/env";

import { getServiceContainer } from "@/server/services/service-container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return apiResponse(request, async (actor) => {
    const setting = await getServiceContainer().settings.get(actor.ownerId);
    return getModelReadiness(loadServerEnv(), setting.provider);
  });
}
