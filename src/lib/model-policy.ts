import type { ModelProvider } from "@/core/domain/contracts";

export const MODEL_PRIVACY_POLICY_VERSION = "2026-09-24";

export function hasCurrentModelConsent(setting: {
  provider: ModelProvider;
  privacyAcceptedAt: string | null;
  privacyProvider: ModelProvider | null;
  privacyPolicyVersion: string | null;
}): boolean {
  return Boolean(setting.privacyAcceptedAt
    && setting.privacyProvider === setting.provider
    && setting.privacyPolicyVersion === MODEL_PRIVACY_POLICY_VERSION);
}

export function modelProviderName(provider: ModelProvider): string {
  return provider === "deepseek" ? "DeepSeek" : provider === "qwen" ? "阿里云百炼" : "预设流程";
}
