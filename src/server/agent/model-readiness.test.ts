import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { loadServerEnv } from "../config/env";
import { getModelReadiness } from "./model-readiness";

it("reports missing Qwen configuration when either required server value is absent", () => {
  const secret = randomUUID();
  const cases = [
    loadServerEnv({}),
    loadServerEnv({ DASHSCOPE_API_KEY: secret }),
    loadServerEnv({ DASHSCOPE_BASE_URL: "https://example.invalid/v1" }),
  ];
  for (const env of cases) {
    expect(getModelReadiness(env, "qwen")).toMatchObject({ provider: "qwen", configured: false, liveVerified: false, status: "configuration_missing" });
  }
  expect(getModelReadiness(loadServerEnv({}), "mock")).toMatchObject({ provider: "mock", configured: false, liveVerified: false, status: "mock_selected" });
});

it("reports complete Qwen configuration as not live verified without disclosing server values", () => {
  const secret = randomUUID();
  const baseURL = "https://synthetic-provider.example.invalid/v1";
  const readiness = getModelReadiness(loadServerEnv({ DASHSCOPE_API_KEY: secret, DASHSCOPE_BASE_URL: baseURL }), "qwen");
  expect(readiness).toEqual({
    provider: "qwen",
    configured: true,
    liveVerified: false,
    status: "configured_not_verified",
    models: { primary: "qwen3.7-flash-2026-07-15", fallback: "qwen3.7-plus-2026-05-26" },
  });
  expect(JSON.stringify(readiness)).not.toContain(secret);
  expect(JSON.stringify(readiness)).not.toContain(baseURL);
});

it("checks selected DeepSeek credentials separately from Qwen and never claims live verification", () => {
  const secret = randomUUID();
  const env = loadServerEnv({ MODEL_PROVIDER: "qwen", DASHSCOPE_API_KEY: "qwen-synthetic", DASHSCOPE_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: secret });
  const readiness = getModelReadiness(env, "deepseek");
  expect(readiness).toEqual({ provider: "deepseek", configured: true, liveVerified: false, status: "configured_not_verified", models: { primary: "deepseek-flash", fallback: null } });
  expect(JSON.stringify(readiness)).not.toContain(secret);
  expect(getModelReadiness(loadServerEnv({ DASHSCOPE_API_KEY: "qwen-synthetic", DASHSCOPE_BASE_URL: "https://example.invalid/v1" }), "deepseek").configured).toBe(false);
});
