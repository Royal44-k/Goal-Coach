import { AppError } from "../../core/errors/app-error";

export type AuthConfig = { mode: "local" | "invite"; origin: string; secureCookies: boolean };
export function loadAuthConfig(input: Record<string, string | undefined> = process.env): AuthConfig {
  const mode = input.APP_MODE ?? "local";
  const raw = input.APP_ORIGIN ?? "http://127.0.0.1:3000";
  try {
    const url = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((mode !== "local" && mode !== "invite") || !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (mode === "local" && url.hostname !== "127.0.0.1")
      || (mode === "invite" && url.protocol !== "https:" && !loopback)) throw new Error();
    return { mode, origin: url.origin, secureCookies: url.protocol === "https:" };
  } catch {
    throw new AppError("VALIDATION_ERROR", 500, "Invalid APP_MODE or APP_ORIGIN configuration");
  }
}
