// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelReadiness } from "./model-readiness";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("checks only the local readiness route after an explicit action and explains that no live call occurred", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(() => Promise.resolve(Response.json({ ok: true, data: {
    provider: "qwen", configured: true, liveVerified: false, status: "configured_not_verified",
    models: { primary: "qwen3.7-flash-2026-07-15", fallback: "qwen3.7-plus-2026-05-26" },
  } })));
  vi.stubGlobal("fetch", fetchMock);
  render(<ModelReadiness />);

  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "检查模型配置" }));

  expect(await screen.findByRole("status")).toHaveTextContent("服务器配置已填写，但尚未验证供应商连接");
  expect(screen.getByText("此检查不会调用模型，也不会显示凭证或服务地址。")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/settings/model-readiness", { cache: "no-store" });
});

it("uses safe missing-configuration wording when the readiness route reports an incomplete setup", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ ok: true, data: {
    provider: "qwen", configured: false, liveVerified: false, status: "configuration_missing",
    models: { primary: "qwen3.7-flash-2026-07-15", fallback: "qwen3.7-plus-2026-05-26" },
  } }))));
  render(<ModelReadiness />);
  await user.click(screen.getByRole("button", { name: "检查模型配置" }));
  expect(await screen.findByRole("status")).toHaveTextContent("服务器配置不完整");
  expect(document.body.textContent).not.toMatch(/API.?key|base.?url|example\.invalid/i);
});
