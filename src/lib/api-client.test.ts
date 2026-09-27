import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import {
  ReceivedApiError,
  UnknownApiOutcomeError,
  apiClient,
} from "./api-client";

const responseSchema = z.object({ value: z.string() }).strict();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiClient", () => {
  it("returns data only after the success envelope and payload both validate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { value: "已加载" } })));

    await expect(apiClient.request("/api/example", {}, responseSchema)).resolves.toEqual({ value: "已加载" });
  });

  it("classifies a validated non-2xx error envelope as a received API error without retaining raw text", async () => {
    const rawResponse = `\n  ${JSON.stringify({
      ok: false,
      error: { code: "VERSION_CONFLICT", message: "内容已被更新，请刷新后重试。" },
    })}\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(rawResponse, { status: 409, headers: { "Content-Type": "application/json" } })));

    const error = await apiClient.request("/api/example", { method: "PATCH" }, responseSchema).catch(value => value);

    expect(error).toBeInstanceOf(ReceivedApiError);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      kind: "received",
      code: "VERSION_CONFLICT",
      message: "内容已被更新，请刷新后重试。",
      status: 409,
    });
    expect(JSON.stringify(error)).not.toContain(rawResponse);
    expect(error).not.toHaveProperty("rawResponse");
    expect(error).not.toHaveProperty("cause");
  });

  it.each([
    ["non-JSON response", new Response("private gateway response", { status: 502 }), "unreadable_response"],
    ["malformed envelope", Response.json({ ok: false, error: { code: "MADE_UP", message: "private" } }, { status: 500 }), "invalid_envelope"],
    ["success envelope on non-2xx", Response.json({ ok: true, data: { value: "maybe changed" } }, { status: 409 }), "status_mismatch"],
    ["error envelope on 2xx", Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "内容已被更新，请刷新后重试。" } }), "status_mismatch"],
    ["invalid success data", Response.json({ ok: true, data: { value: 42 } }), "invalid_success_data"],
  ])("classifies %s as an unknown outcome", async (_label, response, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await apiClient.request("/api/example", { method: "PATCH" }, responseSchema).catch(value => value);

    expect(error).toBeInstanceOf(UnknownApiOutcomeError);
    expect(error).toMatchObject({ kind: "unknown", reason });
    expect(error.message).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
  });

  it.each([
    ["aborted request", new DOMException("private abort reason", "AbortError"), "aborted"],
    ["network failure", new TypeError("private network reason"), "network"],
  ])("classifies a %s without retrying", async (_label, failure, reason) => {
    const fetchMock = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetchMock);

    const error = await apiClient.request("/api/example", { method: "POST" }, responseSchema).catch(value => value);

    expect(error).toMatchObject({ kind: "unknown", reason });
    expect(error.message).not.toContain("private");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
