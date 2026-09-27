import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { QWEN_FALLBACK_MODEL, QWEN_PRIMARY_MODEL } from "@/lib/public-api-schemas";
import { loadDeepSeekConfig, type DeepSeekConfig } from "./deepseek-config";

export { QWEN_FALLBACK_MODEL, QWEN_PRIMARY_MODEL };
const optionalText = z.preprocess(value => value === "" ? undefined : value, z.string().trim().min(1).optional());
const httpsUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
});
const EnvSchema = z.object({
  DATABASE_PATH: z.string().trim().min(1).default("./data/goal-coach.db"),
  MODEL_PROVIDER: z.enum(["mock", "qwen", "deepseek"]).default("mock"),
  DASHSCOPE_API_KEY: optionalText,
  DASHSCOPE_BASE_URL: z.preprocess(value => value === "" ? undefined : value, httpsUrl.optional()),
  QWEN_MODEL: z.literal(QWEN_PRIMARY_MODEL).default(QWEN_PRIMARY_MODEL),
  QWEN_FALLBACK_MODEL: z.literal(QWEN_FALLBACK_MODEL).default(QWEN_FALLBACK_MODEL),
  ENABLE_QWEN_FALLBACK: z.enum(["false", "true"]).default("false"),
  QWEN_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(8192).default(2048),
  DAILY_INPUT_TOKEN_LIMIT: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(100000),
  DAILY_OUTPUT_TOKEN_LIMIT: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(30000),
});
export type ServerEnv = {
  databasePath: string; provider: "mock" | "qwen" | "deepseek"; apiKey?: string; baseURL?: string;
  deepseek: DeepSeekConfig;
  model: typeof QWEN_PRIMARY_MODEL; fallbackModel: typeof QWEN_FALLBACK_MODEL;
  fallbackEnabled: boolean; qwenMaxOutputTokens?: number;
  dailyInputTokenLimit: number; dailyOutputTokenLimit: number;
};
const QwenConfigSchema = z.object({ apiKey: z.string().trim().min(1), baseURL: httpsUrl,
  model: z.literal(QWEN_PRIMARY_MODEL), fallbackModel: z.literal(QWEN_FALLBACK_MODEL), fallbackEnabled: z.boolean(),
  qwenMaxOutputTokens: z.number().int().min(128).max(8192).default(2048) }).strict();
export type QwenConfig = z.infer<typeof QwenConfigSchema>;
function invalidConfig(): never {
  // Never attach input, Zod issues or an upstream cause containing credentials.
  throw new AppError("MODEL_CONFIG_MISSING", 503, "Server model configuration is missing or invalid");
}
/** Server process configuration and first-run defaults, not browser input or saved settings. */
export function loadServerEnv(input: Record<string, string | undefined> = process.env): ServerEnv {
  if (typeof window !== "undefined") invalidConfig();
  const result = EnvSchema.safeParse(input);
  if (!result.success) invalidConfig();
  const value = result.data;
  if (value.DASHSCOPE_API_KEY && Object.entries(input).some(([key, entry]) =>
    key.startsWith("NEXT_PUBLIC_") && (entry === input.DASHSCOPE_API_KEY || entry === value.DASHSCOPE_API_KEY))) invalidConfig();
  const env: ServerEnv = {
    databasePath: value.DATABASE_PATH, provider: value.MODEL_PROVIDER,
    apiKey: value.DASHSCOPE_API_KEY, baseURL: value.DASHSCOPE_BASE_URL,
    deepseek: loadDeepSeekConfig(input),
    model: value.QWEN_MODEL, fallbackModel: value.QWEN_FALLBACK_MODEL,
    fallbackEnabled: value.ENABLE_QWEN_FALLBACK === "true",
    qwenMaxOutputTokens: value.QWEN_MAX_OUTPUT_TOKENS,
    dailyInputTokenLimit: value.DAILY_INPUT_TOKEN_LIMIT, dailyOutputTokenLimit: value.DAILY_OUTPUT_TOKEN_LIMIT,
  };
  return env;
}
/** Also called when persisted settings select qwen while the environment default remains mock. */
export function requireQwenConfig(env: ServerEnv): QwenConfig {
  if (typeof window !== "undefined") invalidConfig();
  const parsed = QwenConfigSchema.safeParse({ apiKey: env.apiKey, baseURL: env.baseURL,
    model: env.model, fallbackModel: env.fallbackModel, fallbackEnabled: env.fallbackEnabled,
    qwenMaxOutputTokens: env.qwenMaxOutputTokens });
  if (!parsed.success) invalidConfig();
  return parsed.data;
}
