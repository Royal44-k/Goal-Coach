import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { loadServerEnv } from "../config/env";
import { resolveEffectiveModelPolicy } from "../config/effective-model-policy";
import { createServiceContainer } from "./service-container";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import type { ModelRequest } from "../agent/model-contracts";
import { AppError } from "@/core/errors/app-error";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.$client.close()));

function setup(input: Record<string, string | undefined> = {}) {
  const db = createDatabase(":memory:"); databases.push(db); migrateDatabase(db);
  const repositories = createRepositories(db);
  const env = loadServerEnv(input);
  return { db, repositories, env, services: createServiceContainer({ repositories, env }) };
}

it("resolves DeepSeek without exposing credentials or borrowing Qwen fallback", () => {
  const env = loadServerEnv({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic" });
  const policy = resolveEffectiveModelPolicy(env, "deepseek");
  expect(policy).toEqual({ provider: "deepseek", primaryModel: "deepseek-flash", fallbackModel: null, fallbackEnabled: false });
  expect(policy).not.toHaveProperty("apiKey");
  expect(env.apiKey).toBeUndefined();
});

it("binds consent to the selected provider and policy version before admission", async () => {
  const { services, repositories, db } = setup({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic" });
  const { goal } = await services.goals.create(LOCAL_OWNER_ID, { category: "learning", initialMessage: "学习" });
  let setting = await services.settings.get(LOCAL_OWNER_ID);
  await expect(services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: true })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  setting = await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: "deepseek", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
  expect(setting).toMatchObject({ privacyProvider: "deepseek", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION, model: "deepseek-flash" });
  const input = { goalId: goal.id, message: "继续", requestOperationId: randomUUID() };
  await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: false });
  await expect(services.agent.processTurn(LOCAL_OWNER_ID, input)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(db.$client.prepare("SELECT count(*) AS n FROM agent_runs").get()).toEqual({ n: 0 });
  expect(await repositories.support.getOperationByOperationId(LOCAL_OWNER_ID, `agent-turn:${input.requestOperationId}`)).toBeNull();
});

it("does not treat Qwen consent or a legacy timestamp as DeepSeek consent", async () => {
  const { services, repositories } = setup({ DEEPSEEK_API_KEY: "synthetic" });
  const { goal } = await services.goals.create(LOCAL_OWNER_ID, { category: "learning", initialMessage: "学习" });
  let setting = await services.settings.get(LOCAL_OWNER_ID);
  setting = await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, provider: "qwen" });
  setting = await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: "qwen", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
  await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, provider: "deepseek" });
  await expect(services.agent.processTurn(LOCAL_OWNER_ID, { goalId: goal.id, message: "继续", requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  const persisted = await repositories.support.getSettingsByOwner(LOCAL_OWNER_ID);
  await repositories.support.updateAppSetting(LOCAL_OWNER_ID, persisted!.id, persisted!.version, { privacyAcceptedAt: new Date().toISOString(), privacyProvider: null, privacyPolicyVersion: null });
  await expect(services.agent.processTurn(LOCAL_OWNER_ID, { goalId: goal.id, message: "继续", requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
});

it("uses each saved provider's credentials and model across requests and persisted runs", async () => {
  const { repositories, db, env } = setup({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-deepseek" });
  const seen: Array<{ provider: string; request: ModelRequest }> = [];
  const decorator = (_client: unknown, { provider }: { provider: "mock" | "qwen" | "deepseek" }) => ({ async complete(request: ModelRequest) {
    seen.push({ provider, request });
    return { text: "你的下一步是什么？", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
  } });
  const deepseekServices = createServiceContainer({ repositories, env, modelClientDecorator: decorator });
  const qwenServices = createServiceContainer({ repositories, env: loadServerEnv({ MODEL_PROVIDER: "deepseek", DASHSCOPE_API_KEY: "synthetic-qwen", DASHSCOPE_BASE_URL: "https://example.invalid/v1" }), modelClientDecorator: decorator });
  const deepseekOwner = LOCAL_OWNER_ID;
  const qwenOwner = randomUUID();
  for (const [account, provider, model] of [[deepseekOwner, "deepseek", "deepseek-flash"], [qwenOwner, "qwen", "qwen3.7-flash-2026-07-15"]] as const) {
    const services = provider === "deepseek" ? deepseekServices : qwenServices;
    const { goal } = await services.goals.create(account, { category: "learning", initialMessage: "学习" });
    let setting = await services.settings.get(account);
    if (provider !== setting.provider) setting = await services.settings.update(account, { expectedVersion: setting.version, provider });
    setting = await services.settings.update(account, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: provider, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
    expect(setting.model).toBe(model);
    await services.agent.processTurn(account, { goalId: goal.id, message: "继续", requestOperationId: randomUUID() });
    const run = db.$client.prepare("SELECT model FROM agent_runs WHERE owner_id = ?").get(account) as { model: string };
    expect(run.model).toBe(model);
  }
  expect(seen.map(({ provider, request }) => [provider, request.model])).toEqual([["deepseek", "deepseek-flash"], ["qwen", "qwen3.7-flash-2026-07-15"]]);
});

it("rejects a new provider consent in the same settings change as the provider switch", async () => {
  const { services } = setup();
  const setting = await services.settings.get(LOCAL_OWNER_ID);
  await expect(services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, provider: "deepseek", privacyAccepted: true, privacyProvider: "deepseek", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

it("keeps DeepSeek fallback disabled even when a stale local form requests it", async () => {
  const { services } = setup({ MODEL_PROVIDER: "deepseek" });
  const setting = await services.settings.get(LOCAL_OWNER_ID);
  const updated = await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, fallbackEnabled: true });
  expect(updated).toMatchObject({ provider: "deepseek", model: "deepseek-flash", fallbackEnabled: false });
});

it("preserves a stored Qwen model on read and synchronizes it when selecting DeepSeek", async () => {
  const { services, repositories } = setup();
  let setting = await services.settings.get(LOCAL_OWNER_ID);
  setting = await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, provider: "qwen" });
  await repositories.support.updateAppSetting(LOCAL_OWNER_ID, setting.id, setting.version, { model: "qwen-historical-model" });
  setting = await services.settings.get(LOCAL_OWNER_ID);
  expect(setting.model).toBe("qwen-historical-model");
  const selected = await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, provider: "deepseek" });
  expect(selected.model).toBe("deepseek-flash");
});

it("reconciles a saved local DeepSeek model after a configuration change", async () => {
  const { db, repositories, services } = setup({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic", DEEPSEEK_MODEL: "deepseek-flash" });
  const { goal } = await services.goals.create(LOCAL_OWNER_ID, { category: "learning", initialMessage: "学习" });
  let setting = await services.settings.get(LOCAL_OWNER_ID);
  setting = await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: "deepseek", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
  expect(setting.model).toBe("deepseek-flash");

  const requests: ModelRequest[] = [];
  const restarted = createServiceContainer({
    repositories,
    env: loadServerEnv({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic", DEEPSEEK_MODEL: "deepseek-v4-pro" }),
    modelClientDecorator: () => ({ async complete(request: ModelRequest) {
      requests.push(request);
      return { text: "你的下一步是什么？", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
    } }),
  });
  const current = await restarted.settings.get(LOCAL_OWNER_ID);
  expect(current).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", fallbackEnabled: false });
  expect((await repositories.support.getSettingsByOwner(LOCAL_OWNER_ID))?.model).toBe("deepseek-v4-pro");
  await restarted.agent.processTurn(LOCAL_OWNER_ID, { goalId: goal.id, message: "继续", requestOperationId: randomUUID() });
  expect(requests.map(request => request.model)).toEqual(["deepseek-v4-pro"]);
  expect(db.$client.prepare("SELECT model FROM agent_runs").get()).toEqual({ model: "deepseek-v4-pro" });
});

it("stops the next DeepSeek dispatch after consent is withdrawn mid-turn", async () => {
  const { repositories, env } = setup({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic" });
  let requests = 0;
  const services = createServiceContainer({ repositories, env, modelClientDecorator: () => ({ async complete() {
    requests++;
    if (requests === 1) {
      const setting = await services.settings.get(LOCAL_OWNER_ID);
      await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: false });
      return { text: "", toolCalls: [{ id: randomUUID(), name: "get_goal", argumentsJson: JSON.stringify({ goalId: goal.id }) }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" };
    }
    throw new Error("second provider dispatch occurred");
  } }) });
  const { goal } = await services.goals.create(LOCAL_OWNER_ID, { category: "learning", initialMessage: "学习" });
  const setting = await services.settings.get(LOCAL_OWNER_ID);
  await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: "deepseek", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
  await expect(services.agent.processTurn(LOCAL_OWNER_ID, { goalId: goal.id, message: "继续", requestOperationId: randomUUID() })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(requests).toBe(1);
});

it("keeps DeepSeek on one model for timeout retry and conversation summary", async () => {
  const { repositories, env, db } = setup({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic" });
  const requests: ModelRequest[] = [];
  const services = createServiceContainer({ repositories, env, modelClientDecorator: () => ({ async complete(request) {
    requests.push(request);
    if (requests.length === 1) throw new AppError("MODEL_TIMEOUT", 504, "synthetic timeout");
    return { text: requests.length === 2 ? "你的下一步是什么？" : "合成摘要。", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
  } }) });
  const { goal } = await services.goals.create(LOCAL_OWNER_ID, { category: "learning", initialMessage: "学习" });
  const setting = await services.settings.get(LOCAL_OWNER_ID);
  await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: "deepseek", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
  for (let index = 0; index < 12; index++) await repositories.conversations.append(LOCAL_OWNER_ID, goal.id, { role: "user", content: `历史${index}` });
  const result = await services.agent.processTurn(LOCAL_OWNER_ID, { goalId: goal.id, message: "继续", requestOperationId: randomUUID() });
  expect(result.usage.modelCalls).toBe(3);
  expect(requests.map(request => request.model)).toEqual(["deepseek-flash", "deepseek-flash", "deepseek-flash"]);
  expect(await repositories.conversations.getSummary(LOCAL_OWNER_ID, goal.id)).toMatchObject({ content: "合成摘要。" });
  expect(db.$client.prepare("SELECT model FROM agent_runs").get()).toEqual({ model: "deepseek-flash" });
});
