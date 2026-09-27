import type { ServerEnv } from "../config/env";
import { loadAuthConfig } from "../auth/auth-config";
import { AppError } from "@/core/errors/app-error";
import type { Repositories, RepositoryUnitOfWork, TransactionRepositories } from "../repositories/repository-types";
import { PreferencesUpdateSchema, PublicSettingsSchema, SettingsUpdateSchema } from "./service-contracts";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import { resolveEffectiveModelPolicy } from "../config/effective-model-policy";
export const defaultPreferences = { taskGranularity: "medium" as const, preferredTimeWindow: null, estimateBias: 1, commonBlockers: [], effectiveStrategies: [] };
export function defaultSettings(env: ServerEnv) { const policy = resolveEffectiveModelPolicy(env, env.provider); return { privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null, provider: env.provider, model: policy.primaryModel, fallbackEnabled: policy.fallbackEnabled, dailyInputTokenLimit: env.dailyInputTokenLimit, dailyOutputTokenLimit: env.dailyOutputTokenLimit }; }
export function ensurePreferences(tx: TransactionRepositories, owner: string) { return tx.support.getPreferencesByOwner(owner) ?? tx.support.createUserPreference(owner, defaultPreferences); }
export class SettingsService {
  constructor(private readonly r: Repositories & RepositoryUnitOfWork, private readonly env: ServerEnv, private readonly now: () => Date) {}
  async get(owner: string) {
    return this.r.withTransaction(tx => {
      let setting = tx.support.getSettingsByOwner(owner) ?? tx.support.createAppSetting(owner, defaultSettings(this.env));
      if (loadAuthConfig().mode === "invite") {
        const effective = resolveEffectiveModelPolicy(this.env, this.env.provider);
        const policy = { provider: this.env.provider, model: effective.primaryModel, fallbackEnabled: effective.fallbackEnabled, dailyInputTokenLimit: this.env.dailyInputTokenLimit, dailyOutputTokenLimit: this.env.dailyOutputTokenLimit };
        if (Object.entries(policy).some(([key, value]) => setting[key as keyof typeof policy] !== value))
          setting = tx.support.updateAppSetting(owner, setting.id, setting.version, policy);
      } else if (setting.provider === "deepseek") {
        const effective = resolveEffectiveModelPolicy(this.env, "deepseek");
        if (setting.model !== effective.primaryModel || setting.fallbackEnabled)
          setting = tx.support.updateAppSetting(owner, setting.id, setting.version, { model: effective.primaryModel, fallbackEnabled: false });
      }
      return PublicSettingsSchema.strip().parse({ ...setting, apiKeyConfigured: this.configured(setting.provider) });
    });
  }
  async update(owner: string, raw: unknown) {
    const { expectedVersion, privacyAccepted, privacyProvider, privacyPolicyVersion, ...patch } = SettingsUpdateSchema.parse(raw);
    if (loadAuthConfig().mode === "invite" && Object.keys(patch).length)
      throw new AppError("AUTH_FORBIDDEN", 403, "Server model policy is read-only");
    await this.get(owner);
    return this.r.withTransaction(tx => {
      const current = tx.support.getSettingsByOwner(owner)!;
      const provider = patch.provider ?? current.provider;
      if (privacyAccepted === true && patch.provider !== undefined && patch.provider !== current.provider)
        throw new AppError("VALIDATION_ERROR", 400, "Read the selected provider disclosure before accepting");
      if (privacyAccepted === true && (privacyProvider !== provider || privacyPolicyVersion !== MODEL_PRIVACY_POLICY_VERSION))
        throw new AppError("VALIDATION_ERROR", 400, "Privacy consent must match current provider and policy");
      if (privacyAccepted !== true && (privacyProvider !== undefined || privacyPolicyVersion !== undefined))
        throw new AppError("VALIDATION_ERROR", 400, "Privacy binding requires acceptance");
      const effective = resolveEffectiveModelPolicy(this.env, provider);
      const setting = tx.support.updateAppSetting(owner, current.id, expectedVersion, {
        ...patch,
        ...(patch.provider === undefined ? {} : { model: effective.primaryModel, fallbackEnabled: provider === "deepseek" ? false : patch.fallbackEnabled ?? (provider === current.provider ? current.fallbackEnabled : effective.fallbackEnabled) }),
        ...(provider === "deepseek" ? { model: effective.primaryModel, fallbackEnabled: false } : {}),
        ...(privacyAccepted === undefined ? {} : { privacyAcceptedAt: privacyAccepted ? this.now().toISOString() : null,
          privacyProvider: privacyAccepted ? privacyProvider! : null, privacyPolicyVersion: privacyAccepted ? privacyPolicyVersion! : null }),
      });
      return PublicSettingsSchema.strip().parse({ ...setting, apiKeyConfigured: this.configured(setting.provider) });
    });
  }
  private configured(provider: "mock" | "qwen" | "deepseek") {
    return provider === "deepseek" ? Boolean(this.env.deepseek.apiKey) : Boolean(this.env.apiKey);
  }
  getPreferences(owner: string) { return this.r.withTransaction(tx => ensurePreferences(tx, owner)); }
  updatePreferences(owner: string, raw: unknown) {
    const { expectedVersion, ...patch } = PreferencesUpdateSchema.parse(raw);
    return this.r.withTransaction(tx => { const value = ensurePreferences(tx, owner); return tx.support.updateUserPreference(owner, value.id, expectedVersion, patch); });
  }
  clearPreferences(owner: string) { return this.r.withTransaction(tx => { const value = ensurePreferences(tx, owner); return tx.support.updateUserPreference(owner, value.id, value.version, defaultPreferences); }); }
}
