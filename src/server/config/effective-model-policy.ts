import type { ModelProvider } from "@/core/domain/contracts";
import { QWEN_FALLBACK_MODEL, QWEN_PRIMARY_MODEL } from "@/lib/public-api-schemas";
import type { ServerEnv } from "./env";

export type EffectiveModelPolicy = {
  provider: ModelProvider;
  primaryModel: string;
  fallbackModel: string | null;
  fallbackEnabled: boolean;
};

export function resolveEffectiveModelPolicy(env: ServerEnv, provider: ModelProvider): EffectiveModelPolicy {
  if (provider === "deepseek") return { provider, primaryModel: env.deepseek.model, fallbackModel: null, fallbackEnabled: false };
  return { provider, primaryModel: QWEN_PRIMARY_MODEL, fallbackModel: QWEN_FALLBACK_MODEL, fallbackEnabled: env.fallbackEnabled };
}
