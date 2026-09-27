import { QWEN_FALLBACK_MODEL, QWEN_PRIMARY_MODEL } from "@/lib/public-api-schemas";
import type { ModelReadiness } from "@/lib/public-api-schemas";
import type { ModelProvider } from "@/core/domain/contracts";
import type { ServerEnv } from "../config/env";

export { ModelReadinessSchema, type ModelReadiness } from "@/lib/public-api-schemas";

/** Offline-only configuration projection. It deliberately performs no provider request. */
export function getModelReadiness(env: ServerEnv, provider: ModelProvider): ModelReadiness {
  const configured = provider === "deepseek" ? Boolean(env.deepseek.apiKey) : Boolean(env.apiKey && env.baseURL);
  return {
    provider,
    configured,
    liveVerified: false,
    status: provider === "mock" ? "mock_selected" : configured ? "configured_not_verified" : "configuration_missing",
    models: provider === "deepseek" ? { primary: env.deepseek.model, fallback: null } : { primary: QWEN_PRIMARY_MODEL, fallback: QWEN_FALLBACK_MODEL },
  };
}
