import { expect, it } from "vitest";
import { loadDeepSeekConfig, requireDeepSeekConfig } from "./deepseek-config";

const secret = "synthetic-secret";

it("defaults to the pinned flash model and bounded output", () => {
  expect(loadDeepSeekConfig({ DEEPSEEK_API_KEY: secret })).toEqual({
    apiKey: secret, baseURL: "https://api.deepseek.com", model: "deepseek-flash", maxOutputTokens: 4096,
  });
  expect(() => requireDeepSeekConfig(loadDeepSeekConfig({}))).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});

it.each(["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/"])("normalizes the allowed base URL %s", url => {
  expect(loadDeepSeekConfig({ DEEPSEEK_BASE_URL: url }).baseURL).toBe(url.includes("/v1") ? "https://api.deepseek.com/v1" : "https://api.deepseek.com");
});

it.each(["http://api.deepseek.com", "https://api.deepseek.com.attacker.invalid", "https://api.deepseek.com/other", "https://api.deepseek.com/?q=1", "https://api.deepseek.com/#fragment", "https://user@api.deepseek.com", "https://api.deepseek.com:444"])("rejects unsafe endpoint %s", url => {
  expect(() => loadDeepSeekConfig({ DEEPSEEK_BASE_URL: url })).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});

it.each(["deepseek-flash", "deepseek-v4-pro"] as const)("accepts pinned model %s", model => {
  expect(loadDeepSeekConfig({ DEEPSEEK_MODEL: model }).model).toBe(model);
});

it.each(["other", "deepseek-reasoner", ""])("rejects unpinned model %s", model => {
  expect(() => loadDeepSeekConfig({ DEEPSEEK_MODEL: model })).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});

it.each([["128", 128], ["2048", 2048], ["8192", 8192]] as const)("accepts explicit token limit %s", (value, expected) => {
  expect(loadDeepSeekConfig({ DEEPSEEK_MAX_OUTPUT_TOKENS: value }).maxOutputTokens).toBe(expected);
});

it.each(["127", "8193", "1.5", "abc", ""])("rejects invalid token limit %s", value => {
  expect(() => loadDeepSeekConfig({ DEEPSEEK_MAX_OUTPUT_TOKENS: value })).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});

it("treats blank key as absent and refuses public key exposure with sanitized errors", () => {
  expect(loadDeepSeekConfig({ DEEPSEEK_API_KEY: "  " }).apiKey).toBeUndefined();
  expect(() => requireDeepSeekConfig(loadDeepSeekConfig({ DEEPSEEK_API_KEY: "  " }))).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
  try { loadDeepSeekConfig({ DEEPSEEK_API_KEY: secret, NEXT_PUBLIC_COPY: secret }); throw new Error("accepted"); }
  catch (error) {
    expect(error).toMatchObject({ code: "MODEL_CONFIG_MISSING" });
    expect(JSON.stringify(error)).not.toContain(secret);
  }
});

it("revalidates a supplied config before a client can use its endpoint", () => {
  const config = loadDeepSeekConfig({ DEEPSEEK_API_KEY: secret });
  expect(() => requireDeepSeekConfig({ ...config, baseURL: "https://api.deepseek.com.attacker.invalid" })).toThrowError(expect.objectContaining({ code: "MODEL_CONFIG_MISSING" }));
});
