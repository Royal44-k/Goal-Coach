const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(key|token|secret|password)/i;
const ASSIGNMENT = /(\b[\w.-]*(?:key|token|secret|password)[\w.-]*\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;
const BEARER = /(\bBearer\s+)[^\s,;]+/gi;
const SK_TOKEN = /\bsk-[A-Za-z0-9._-]+/g;

function redactString(value: string): string {
  return value
    .replace(BEARER, `$1${REDACTED}`)
    .replace(ASSIGNMENT, `$1${REDACTED}`)
    .replace(SK_TOKEN, REDACTED);
}

export function redactSensitive(value: string): string;
export function redactSensitive(value: unknown): unknown;
export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(child),
    ]));
  }
  return value;
}
