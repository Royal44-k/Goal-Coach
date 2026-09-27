import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { loadServerEnv, requireQwenConfig } from "./env";

it("uses mock defaults without requiring credentials", () => {
  expect(loadServerEnv({})).toMatchObject({ provider: "mock", model: "qwen3.7-flash-2026-07-15", fallbackEnabled: false, qwenMaxOutputTokens: 2048, dailyInputTokenLimit: 100000, dailyOutputTokenLimit: 30000 });
});
it.each([128, 8192])("accepts inclusive Qwen output limit boundary %i from the environment", value => {
  expect(loadServerEnv({ QWEN_MAX_OUTPUT_TOKENS: String(value) })).toMatchObject({ qwenMaxOutputTokens: value });
});
it("fails closed for qwen without server credentials, including saved qwen over mock env", () => {
  expect(() => requireQwenConfig(loadServerEnv({ MODEL_PROVIDER: "qwen" }))).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
  expect(() => requireQwenConfig(loadServerEnv({ MODEL_PROVIDER: "mock" }))).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});
it.each([
  { DASHSCOPE_BASE_URL: "http://example.invalid/v1" },
  { QWEN_MODEL: "unpinned" }, { QWEN_FALLBACK_MODEL: "unpinned" },
  { ENABLE_QWEN_FALLBACK: "yes" }, { DAILY_INPUT_TOKEN_LIMIT: "0" },
  { DAILY_OUTPUT_TOKEN_LIMIT: "1.5" }, { QWEN_MAX_OUTPUT_TOKENS: "127" },
  { QWEN_MAX_OUTPUT_TOKENS: "8193" }, { QWEN_MAX_OUTPUT_TOKENS: "1.5" },
  { MODEL_PROVIDER: "other" },
])("rejects invalid configuration without leaking values: %j", patch => {
  expect(() => loadServerEnv({ ...patch })).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});
it("defaults an omitted direct Qwen limit and accepts both direct boundaries", () => {
  const configured = loadServerEnv({ DASHSCOPE_API_KEY: randomUUID(), DASHSCOPE_BASE_URL: "https://example.invalid/v1" });
  expect(requireQwenConfig({ ...configured, qwenMaxOutputTokens: undefined })).toMatchObject({ qwenMaxOutputTokens: 2048 });
  for (const qwenMaxOutputTokens of [128, 8192]) {
    expect(requireQwenConfig({ ...configured, qwenMaxOutputTokens })).toMatchObject({ qwenMaxOutputTokens });
  }
});
it.each([127, 8193])("rejects out-of-range direct Qwen limit %i", qwenMaxOutputTokens => {
  const configured = loadServerEnv({ DASHSCOPE_API_KEY: randomUUID(), DASHSCOPE_BASE_URL: "https://example.invalid/v1" });
  expect(() => requireQwenConfig({ ...configured, qwenMaxOutputTokens })).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});
it("accepts validated server-only credentials and rejects a public alias without echoing them", () => {
  const secret = randomUUID(); // Deliberately not a provider credential.
  const input = { MODEL_PROVIDER: "qwen", DASHSCOPE_API_KEY: secret, DASHSCOPE_BASE_URL: "https://example.invalid/v1" };
  expect(requireQwenConfig(loadServerEnv(input))).toMatchObject({ apiKey: secret, baseURL: "https://example.invalid/v1" });
  for (const key of ["NEXT_PUBLIC_KEY", "NEXT_PUBLIC_OTHER"]) {
    try { loadServerEnv({ ...input, [key]: secret }); throw new Error("accepted"); }
    catch (error) { expect(error).toMatchObject({ code: "MODEL_CONFIG_MISSING" }); expect(String(error)).not.toContain(secret); }
  }
});
