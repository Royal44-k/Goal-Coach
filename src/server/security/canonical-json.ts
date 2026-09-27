import { createHash } from "node:crypto";
import { AppError } from "@/core/errors/app-error";

function invalid(reason: string): never {
  throw new AppError("VALIDATION_ERROR", 400, `Value is not canonical JSON: ${reason}`);
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("number must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalid(`unsupported ${typeof value}`);
  if (ancestors.has(value)) invalid("cyclic object");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) invalid("sparse array element");
        items.push(encode(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("non-plain object");
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key =>
      `${JSON.stringify(key)}:${encode(object[key], ancestors)}`,
    ).join(",")}}`;
  }
  finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
