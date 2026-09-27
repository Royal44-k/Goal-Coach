// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import HomePage from "./page";

const settings = {
  id: "28fde2ef-ff84-4b67-9f21-95f1a69fbb26",
  createdAt: "2026-09-16T08:00:00+08:00",
  updatedAt: "2026-09-16T08:00:00+08:00",
  version: 1,
  privacyAcceptedAt: null,
  privacyProvider: null,
  privacyPolicyVersion: null,
  provider: "mock",
  model: "qwen3.7-flash-2026-07-15",
  fallbackEnabled: false,
  dailyInputTokenLimit: 100000,
  dailyOutputTokenLimit: 30000,
  apiKeyConfigured: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("introduces the coach without decorative product labels", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: "自适应目标教练" })).toBeInTheDocument();
  expect(screen.getByText("把目标变成今天能开始的行动")).toBeInTheDocument();
  expect(screen.queryByText("本机 · 私密 · 可撤销")).not.toBeInTheDocument();
});

it("loads private state in the client, records acceptance once, and reveals the empty goal action", async () => {
  const user = userEvent.setup();
  const acceptedSettings = { ...settings, version: 2, privacyAcceptedAt: "2026-09-16T08:05:00+08:00", privacyProvider: "mock", privacyPolicyVersion: "2026-09-24" };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: true, data: settings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: acceptedSettings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: acceptedSettings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  render(<HomePage />);

  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));

  expect(await screen.findByRole("heading", { name: "还没有目标" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "创建第一个目标" })).toHaveAttribute("href", "/goals/new");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
  expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/settings", expect.objectContaining({
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: 1, privacyAccepted: true, privacyProvider: "mock", privacyPolicyVersion: "2026-09-24" }),
  }));
});
