// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ReceivedApiError, UnknownApiOutcomeError } from "@/lib/api-client";
import { PrivacyGate } from "./privacy-gate";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";

afterEach(cleanup);
const pending = { provider: "qwen" as const, privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null };
const accepted = { provider: "qwen" as const, privacyAcceptedAt: "2026-09-16T08:00:00+08:00", privacyProvider: "qwen" as const, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION };

it("shows DeepSeek disclosure and requires fresh binding after provider changes", () => {
  render(<PrivacyGate settings={{ provider: "deepseek", privacyAcceptedAt: "2026-09-16T08:00:00+08:00", privacyProvider: "qwen", privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION }} onAccept={vi.fn()} onReload={vi.fn()}><p>受保护内容</p></PrivacyGate>);
  expect(screen.getByText(/必要的目标内容会发送至 DeepSeek/)).toBeInTheDocument();
  expect(screen.queryByText("受保护内容")).not.toBeInTheDocument();
});

it("explains model data sharing and keeps data controls available before acceptance", () => {
  const onAccept = vi.fn();
  render(<PrivacyGate settings={pending} onAccept={onAccept} onReload={vi.fn()}><p>受保护内容</p></PrivacyGate>);

  expect(screen.getByText(/必要的目标内容会发送至阿里云百炼/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "我已理解并继续" })).toBeEnabled();
  expect(screen.getByRole("link", { name: "查看数据与隐私设置" })).toHaveAttribute("href", "/settings#data-controls");
  expect(screen.queryByText("受保护内容")).not.toBeInTheDocument();
});

it("reveals protected content after privacy has been accepted", () => {
  render(<PrivacyGate settings={accepted} onAccept={vi.fn()} onReload={vi.fn()}><p>受保护内容</p></PrivacyGate>);

  expect(screen.getByText("受保护内容")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "我已理解并继续" })).not.toBeInTheDocument();
});

it("prevents duplicate acceptance and offers recovery when saving fails", async () => {
  const user = userEvent.setup();
  const onAccept = vi.fn().mockRejectedValue(new Error("private failure"));
  render(<PrivacyGate settings={pending} onAccept={onAccept} onReload={vi.fn()}><p>受保护内容</p></PrivacyGate>);

  await user.click(screen.getByRole("button", { name: "我已理解并继续" }));

  expect(onAccept).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toHaveTextContent("暂时无法保存隐私确认，请重试。");
  expect(screen.getByRole("button", { name: "我已理解并继续" })).toBeEnabled();
});

it("routes an unknown outcome to state reconciliation without another acceptance action", async () => {
  const user = userEvent.setup();
  const onAccept = vi.fn().mockRejectedValue(new UnknownApiOutcomeError("network"));
  const onReload = vi.fn();
  render(<PrivacyGate settings={pending} onAccept={onAccept} onReload={onReload}><p>受保护内容</p></PrivacyGate>);

  await user.click(screen.getByRole("button", { name: "我已理解并继续" }));

  expect(screen.getByRole("alert")).toHaveTextContent("无法确认隐私确认是否已保存");
  expect(screen.queryByRole("button", { name: "我已理解并继续" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新读取当前状态" }));
  expect(onReload).toHaveBeenCalledTimes(1);
  expect(onAccept).toHaveBeenCalledTimes(1);
});

it("shows a validated received error separately and permits an explicit retry", async () => {
  const user = userEvent.setup();
  const onAccept = vi.fn().mockRejectedValue(new ReceivedApiError("VERSION_CONFLICT", 409, "内容已被更新，请刷新后重试。"));
  render(<PrivacyGate settings={pending} onAccept={onAccept} onReload={vi.fn()}><p>受保护内容</p></PrivacyGate>);

  await user.click(screen.getByRole("button", { name: "我已理解并继续" }));

  expect(screen.getByRole("alert")).toHaveTextContent("内容已被更新，请刷新后重试。");
  expect(screen.getByRole("button", { name: "我已理解并继续" })).toBeEnabled();
});
