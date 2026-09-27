// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { HomeDashboard } from "./home-dashboard";

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

it("reconciles an unknown privacy outcome to accepted state without a second PATCH", async () => {
  const user = userEvent.setup();
  const acceptedSettings = { ...settings, version: 2, privacyAcceptedAt: "2026-09-16T08:05:00+08:00", privacyProvider: "mock", privacyPolicyVersion: "2026-09-24" };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: true, data: settings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }))
    .mockRejectedValueOnce(new TypeError("private network detail"))
    .mockResolvedValueOnce(Response.json({ ok: true, data: acceptedSettings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  render(<HomeDashboard />);

  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法确认隐私确认是否已保存");
  expect(screen.queryByRole("button", { name: "我已理解并继续" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重新读取当前状态" }));

  expect(await screen.findByRole("heading", { name: "还没有目标" })).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});

it("keeps acceptance non-submittable when unknown-outcome reconciliation fails", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: true, data: settings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }))
    .mockRejectedValueOnce(new TypeError("private mutation outcome"))
    .mockRejectedValueOnce(new TypeError("private reconciliation failure"))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  render(<HomeDashboard />);

  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));
  await user.click(await screen.findByRole("button", { name: "重新读取当前状态" }));

  expect(await screen.findByRole("heading", { name: "无法读取本机状态" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "我已理解并继续" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新读取" })).toBeEnabled();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});

it("uses the refreshed version for a later explicit acceptance after an unknown outcome", async () => {
  const user = userEvent.setup();
  const refreshedSettings = { ...settings, version: 2, updatedAt: "2026-09-16T08:05:00+08:00" };
  const acceptedSettings = { ...refreshedSettings, version: 3, privacyAcceptedAt: "2026-09-16T08:06:00+08:00", privacyProvider: "mock", privacyPolicyVersion: "2026-09-24" };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: true, data: settings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }))
    .mockRejectedValueOnce(new TypeError("private mutation outcome"))
    .mockResolvedValueOnce(Response.json({ ok: true, data: refreshedSettings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: acceptedSettings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: acceptedSettings }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  render(<HomeDashboard />);

  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));
  await user.click(await screen.findByRole("button", { name: "重新读取当前状态" }));
  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));

  expect(await screen.findByRole("heading", { name: "还没有目标" })).toBeInTheDocument();
  const patchCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(patchCalls).toHaveLength(2);
  expect(patchCalls[1]?.[1]).toEqual(expect.objectContaining({
    body: JSON.stringify({ expectedVersion: 2, privacyAccepted: true, privacyProvider: "mock", privacyPolicyVersion: "2026-09-24" }),
  }));
});

it("offers an explicit reload after an initial read fails", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError("private network detail"))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: { ...settings, privacyAcceptedAt: "2026-09-16T08:05:00+08:00", privacyProvider: "mock", privacyPolicyVersion: "2026-09-24" } }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  render(<HomeDashboard />);

  expect(await screen.findByRole("heading", { name: "无法读取本机状态" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("请检查本机服务后重试");
  await user.click(screen.getByRole("button", { name: "重新读取" }));

  expect(await screen.findByRole("heading", { name: "还没有目标" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
