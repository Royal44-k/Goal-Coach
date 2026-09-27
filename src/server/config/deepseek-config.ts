import { z } from "zod";
import { AppError } from "@/core/errors/app-error";

const ModelSchema = z.enum(["deepseek-flash", "deepseek-v4-pro"]);
const ConfigSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  baseURL: z.string(),
  model: ModelSchema,
  maxOutputTokens: z.number().int().min(128).max(8192),
}).strict();
export type DeepSeekConfig = z.infer<typeof ConfigSchema>;

function invalidConfig(): never {
  throw new AppError("MODEL_CONFIG_MISSING", 503, "Server model configuration is missing or invalid");
}

function normalizeBaseURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return invalidConfig(); }
  if (url.protocol !== "https:" || url.hostname !== "api.deepseek.com" || url.port || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) invalidConfig();
  return url.pathname.startsWith("/v1") ? "https://api.deepseek.com/v1" : "https://api.deepseek.com";
}

/** Read only server process values; no raw input or validation detail survives failure. */
export function loadDeepSeekConfig(input: Record<string, string | undefined> = process.env): DeepSeekConfig {
  if (typeof window !== "undefined") invalidConfig();
  const key = input.DEEPSEEK_API_KEY?.trim() || undefined;
  if (key && Object.entries(input).some(([name, value]) => name.startsWith("NEXT_PUBLIC_") && value?.trim() === key)) invalidConfig();
  const rawLimit = input.DEEPSEEK_MAX_OUTPUT_TOKENS;
  const limit = rawLimit === undefined ? 4096 : Number(rawLimit);
  const parsed = ConfigSchema.safeParse({
    apiKey: key,
    baseURL: normalizeBaseURL(input.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"),
    model: input.DEEPSEEK_MODEL ?? "deepseek-flash",
    maxOutputTokens: limit,
  });
  if (!parsed.success) invalidConfig();
  return parsed.data;
}

export function requireDeepSeekConfig(config: DeepSeekConfig): DeepSeekConfig & { apiKey: string } {
  if (typeof window !== "undefined") invalidConfig();
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success || !parsed.data.apiKey) invalidConfig();
  return { ...parsed.data, baseURL: normalizeBaseURL(parsed.data.baseURL) } as DeepSeekConfig & { apiKey: string };
}
