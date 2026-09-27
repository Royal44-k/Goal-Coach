// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSettings } from "./model-settings";

afterEach(cleanup);
it("displays server policy without editable controls in invite mode", () => {
  render(<ModelSettings settings={settings} disabled={false} readOnly onSave={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /保存模型设置/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByText(/由服务器管理员配置/)).toBeInTheDocument();
});

const settings = {
  id: "76000000-0000-4000-8000-000000000010",
  createdAt: "2026-09-17T08:00:00+08:00",
  updatedAt: "2026-09-17T08:00:00+08:00",
  version: 2,
  privacyAcceptedAt: "2026-09-17T08:00:00+08:00",
  privacyProvider: "qwen" as const,
  privacyPolicyVersion: "2026-09-24",
  provider: "qwen" as const,
  model: "qwen3.7-flash-2026-07-15" as const,
  fallbackEnabled: false,
  dailyInputTokenLimit: 100000,
  dailyOutputTokenLimit: 30000,
  apiKeyConfigured: true,
};

it("shows both approved model IDs without presenting incomplete key presence as readiness", () => {
  const { container } = render(<ModelSettings settings={settings} disabled={false} onSave={vi.fn()} />);
  expect(screen.getByText("qwen3.7-flash-2026-07-15")).toBeInTheDocument();
  expect(screen.getByText("qwen3.7-plus-2026-05-26")).toBeInTheDocument();
  expect(screen.queryByText(/凭证/)).not.toBeInTheDocument();
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

it("submits validated public settings without a model or credential field", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(<ModelSettings settings={settings} disabled={false} onSave={onSave} />);
  await user.selectOptions(screen.getByLabelText("模型提供方"), "mock");
  await user.click(screen.getByRole("checkbox", { name: "启用备选模型" }));
  await user.clear(screen.getByLabelText("每日输入 Token 上限"));
  await user.type(screen.getByLabelText("每日输入 Token 上限"), "120000");
  await user.click(screen.getByRole("button", { name: "保存模型设置（设置 2）" }));
  expect(onSave).toHaveBeenCalledWith({ provider: "mock", fallbackEnabled: true, dailyInputTokenLimit: 120000, dailyOutputTokenLimit: 30000 });
});

it("shows DeepSeek's selected model without offering a fallback toggle", () => {
  render(<ModelSettings settings={{ ...settings, provider: "deepseek", model: "deepseek-v4-pro", fallbackEnabled: false, privacyProvider: "deepseek" }} disabled={false} onSave={vi.fn()} />);
  expect(screen.getByText("deepseek-v4-pro")).toBeInTheDocument();
  expect(screen.getByText("无")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "启用备选模型" })).not.toBeInTheDocument();
});
