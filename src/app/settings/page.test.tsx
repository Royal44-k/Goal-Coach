// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import SettingsPage from "./page";

const settingId = "77000000-0000-4000-8000-000000000001";
const preferenceId = "77000000-0000-4000-8000-000000000002";
const settings = {
  id: settingId, createdAt: "2026-09-17T08:00:00+08:00", updatedAt: "2026-09-17T08:00:00+08:00", version: 2,
  privacyAcceptedAt: "2026-09-17T08:00:00+08:00", privacyProvider: "mock" as const, privacyPolicyVersion: "2026-09-24", provider: "mock" as const, model: "qwen3.7-flash-2026-07-15" as const,
  fallbackEnabled: false, dailyInputTokenLimit: 100000, dailyOutputTokenLimit: 30000, apiKeyConfigured: false,
};
const preference = {
  id: preferenceId, ownerId: "77000000-0000-4000-8000-000000000003", createdAt: "2026-09-17T08:00:00+08:00", updatedAt: "2026-09-17T08:00:00+08:00", version: 3,
  taskGranularity: "medium" as const, preferredTimeWindow: "工作日晚间", estimateBias: 1.4, commonBlockers: ["insufficient_time" as const], effectiveStrategies: ["先做最小步骤"],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("switches a local DeepSeek account to mock before cloud consent", async () => {
  const user = userEvent.setup();
  const cloud = { ...settings, provider: "deepseek", model: "deepseek-flash", privacyAcceptedAt: null, privacyProvider: null };
  let current = cloud;
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) return Promise.resolve(Response.json({ ok: true, data: current }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      current = { ...current, ...body, version: current.version + 1, model: "qwen3.7-flash-2026-07-15" };
      return Promise.resolve(Response.json({ ok: true, data: current }));
    }
    throw new Error(`Unexpected ${url}`);
  }));
  render(<SettingsPage />);
  await user.selectOptions(await screen.findByLabelText("模型提供方"), "mock");
  await user.click(screen.getByRole("button", { name: "保存模型设置（设置 2）" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ expectedVersion: 2, provider: "mock" });
  expect(writes[0]).not.toHaveProperty("privacyAccepted");
});

it("withdraws local consent without clearing data or changing provider, then requires explicit reacceptance", async () => {
  const user = userEvent.setup();
  const withdrawn = { ...settings, version: 3, privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null };
  let current: typeof settings | typeof withdrawn = settings;
  const writes: Record<string, unknown>[] = [];
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) return Promise.resolve(Response.json({ ok: true, data: current }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences") return Promise.resolve(Response.json({ ok: true, data: preference }));
    if (url === "/api/settings" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)); writes.push(body); current = withdrawn;
      return Promise.resolve(Response.json({ ok: true, data: withdrawn }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);
  await user.click(await screen.findByRole("button", { name: "撤回模型数据使用同意" }));
  await screen.findByRole("heading", { name: "先确认你的数据如何使用" });
  expect(writes).toEqual([{ expectedVersion: 2, privacyAccepted: false }]);
  expect(screen.getByRole("button", { name: "导出 JSON" })).toBeEnabled();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/data/clear" || url === "/api/agent/turn")).toBe(false);
});

it.each(["conflict", "unknown"])("reconciles %s withdrawal with a read and never replays the PATCH", async outcome => {
  const user = userEvent.setup();
  const withdrawn = { ...settings, version: 3, privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null };
  let reads = 0;
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) {
      reads++;
      return Promise.resolve(Response.json({ ok: true, data: reads === 1 ? settings : withdrawn }));
    }
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences") return Promise.resolve(Response.json({ ok: true, data: preference }));
    if (url === "/api/settings" && init?.method === "PATCH") {
      writes++;
      return outcome === "conflict"
        ? Promise.resolve(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "changed" } }, { status: 409 }))
        : Promise.reject(new TypeError("response lost"));
    }
    throw new Error(`Unexpected ${url}`);
  }));
  render(<SettingsPage />);
  await user.click(await screen.findByRole("button", { name: "撤回模型数据使用同意" }));
  if (outcome === "unknown") {
    await user.click(await screen.findByRole("button", { name: "重新读取模型数据使用同意" }));
  }
  await screen.findByRole("heading", { name: "先确认你的数据如何使用" });
  expect(writes).toBe(1);
  expect(reads).toBe(2);
});

it("reconciles an unknown non-idempotent preference write without replay and preserves the unsaved draft", async () => {
  const user = userEvent.setup();
  let preferenceReads = 0;
  let preferenceWrites = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences" && !init?.method) {
      preferenceReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: preferenceReads === 1 ? preference : { ...preference, version: 4, preferredTimeWindow: "服务器中的值" } }));
    }
    if (url === "/api/settings/preferences" && init?.method === "PATCH") {
      preferenceWrites += 1;
      if (preferenceWrites === 1) return Promise.reject(new TypeError("response lost"));
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ expectedVersion: 4, preferredTimeWindow: "周末上午", effectiveStrategies: ["先列清单"] });
      return Promise.resolve(Response.json({ ok: true, data: { ...preference, ...body, version: 5 } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);

  const timeWindow = await screen.findByLabelText("偏好时间段");
  await user.clear(timeWindow); await user.type(timeWindow, "周末上午");
  const strategies = screen.getByLabelText("有效策略（每行一条）");
  await user.clear(strategies); await user.type(strategies, "先列清单");
  await user.click(screen.getByRole("button", { name: "保存教练偏好（偏好 3）" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法确认教练偏好是否已保存");
  expect(preferenceWrites).toBe(1);

  await user.click(screen.getByRole("button", { name: "重新读取教练偏好" }));
  expect(screen.getByLabelText("偏好时间段")).toHaveValue("周末上午");
  expect(screen.getByRole("button", { name: "保存教练偏好（偏好 4）" })).toBeEnabled();
  expect(preferenceWrites).toBe(1);
  await user.click(screen.getByRole("button", { name: "保存教练偏好（偏好 4）" }));
  await waitFor(() => expect(preferenceWrites).toBe(2));
});

it("retains clear counts through a failed settings read and does not fetch preferences before renewed consent", async () => {
  const user = userEvent.setup();
  let settingsReads = 0;
  let preferencesAfterClear = 0;
  let cleared = false;
  const deletedCounts = { evidence: 1, checkIns: 1, undoRecords: 0, conversationSummaries: 1, conversationMessages: 4, agentRuns: 2, auditEvents: 3, draftArtifacts: 0, tasks: 3, planVersions: 1, operations: 7, goals: 1, approvalGrants: 0, preferences: 1, settings: 1 };
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) {
      settingsReads += 1;
      if (cleared && settingsReads === 2) return Promise.reject(new TypeError("settings read lost"));
      return Promise.resolve(Response.json({ ok: true, data: cleared ? { ...settings, id: "77000000-0000-4000-8000-000000000009", version: 1, privacyAcceptedAt: null } : settings }));
    }
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences") {
      if (cleared) preferencesAfterClear += 1;
      return Promise.resolve(Response.json({ ok: true, data: preference }));
    }
    if (url === "/api/data/clear" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.confirmationPhrase).toBe("清除我的全部本地数据");
      expect(body.expectedSettingId).toBe(settingId);
      expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/);
      cleared = true;
      return Promise.resolve(Response.json({ ok: true, data: { deletedCounts } }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);

  await user.type(await screen.findByLabelText("输入确认短语"), "清除我的全部本地数据");
  await user.click(screen.getByRole("button", { name: "永久清除全部本地数据" }));
  expect(await screen.findByText("目标：1")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("数据已清除，但隐私设置读取失败");
  expect(preferencesAfterClear).toBe(0);
  await user.click(screen.getByRole("button", { name: "重新读取隐私设置" }));
  expect(await screen.findByRole("heading", { name: "先确认你的数据如何使用" })).toBeInTheDocument();
  expect(screen.getByText("目标：1")).toBeInTheDocument();
  expect(screen.getByText("操作记录：7")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "永久清除全部本地数据" })).toBeDisabled();
  expect(preferencesAfterClear).toBe(0);
});

it("keeps data controls reachable before consent and loads preferences only after explicit acceptance", async () => {
  const user = userEvent.setup();
  const privateSettings = { ...settings, privacyAcceptedAt: null };
  const acceptedSettings = { ...settings, version: 3 };
  let preferenceReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) return Promise.resolve(Response.json({ ok: true, data: privateSettings }));
    if (url === "/api/settings" && init?.method === "PATCH") return Promise.resolve(Response.json({ ok: true, data: acceptedSettings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences") { preferenceReads += 1; return Promise.resolve(Response.json({ ok: true, data: preference })); }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);

  expect(await screen.findByRole("heading", { name: "导出或永久清除" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeInTheDocument();
  expect(preferenceReads).toBe(0);
  await user.click(screen.getByRole("button", { name: "我已理解并继续" }));
  expect(await screen.findByText("估时偏差 1.40×")).toBeInTheDocument();
  expect(preferenceReads).toBe(1);
});

it("serializes repeated reconciliation clicks until the active read settles", async () => {
  const user = userEvent.setup();
  let preferenceReads = 0;
  let resolveReconcile!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveReconcile = resolve; });
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences" && !init?.method) {
      preferenceReads += 1;
      return preferenceReads === 1 ? Promise.resolve(Response.json({ ok: true, data: preference })) : pending;
    }
    if (url === "/api/settings/preferences" && init?.method === "PATCH") return Promise.reject(new TypeError("lost"));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);
  await user.click(await screen.findByRole("button", { name: "保存教练偏好（偏好 3）" }));
  const button = await screen.findByRole("button", { name: "重新读取教练偏好" });
  fireEvent.click(button); fireEvent.click(button);
  expect(preferenceReads).toBe(2);
  resolveReconcile(Response.json({ ok: true, data: { ...preference, version: 4 } }));
  expect(await screen.findByRole("button", { name: "保存教练偏好（偏好 4）" })).toBeEnabled();
});

it("does not publish a late export after the settings page unmounts", async () => {
  const user = userEvent.setup();
  let resolveExport!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveExport = resolve; });
  const createObjectURL = vi.fn(() => "blob:test");
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences") return Promise.resolve(Response.json({ ok: true, data: preference }));
    if (url === "/api/export") return pending;
    throw new Error(`Unexpected ${url}`);
  }));
  const view = render(<SettingsPage />);
  await user.click(await screen.findByRole("button", { name: "导出 JSON" }));
  view.unmount();
  resolveExport(Response.json({ ok: true, data: { schemaVersion: 2, exportedAt: "2026-09-17T08:00:00+08:00", goals: [], tasks: [], planVersions: [], checkIns: [], evidence: [], preferences: [], conversationSummaries: [], conversationMessages: [] } }));
  await Promise.resolve(); await Promise.resolve();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it("recovers consent data reads without submitting the successful privacy PATCH again", async () => {
  const user = userEvent.setup();
  const privateSettings = { ...settings, privacyAcceptedAt: null };
  const acceptedSettings = { ...settings, version: 3 };
  let patches = 0;
  let goalReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) return Promise.resolve(Response.json({ ok: true, data: privateSettings }));
    if (url === "/api/settings" && init?.method === "PATCH") { patches += 1; return Promise.resolve(Response.json({ ok: true, data: acceptedSettings })); }
    if (url === "/api/goals") { goalReads += 1; return goalReads === 2 ? Promise.reject(new TypeError("read failed")) : Promise.resolve(Response.json({ ok: true, data: [] })); }
    if (url === "/api/settings/preferences") return Promise.resolve(Response.json({ ok: true, data: preference }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);
  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("隐私确认已保存，但目标与偏好读取失败");
  await user.click(screen.getByRole("button", { name: "重新读取目标与教练偏好" }));
  expect(await screen.findByText("估时偏差 1.40×")).toBeInTheDocument();
  expect(patches).toBe(1);
});

it("offers a fresh explicit consent after an unknown PATCH is authoritatively still unaccepted", async () => {
  const user = userEvent.setup();
  const privateSettings = { ...settings, privacyAcceptedAt: null };
  const refreshedPrivateSettings = { ...privateSettings, version: 4 };
  const acceptedSettings = { ...settings, version: 5 };
  let settingsReads = 0;
  let patches = 0;
  let preferenceReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) {
      settingsReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: settingsReads === 1 ? privateSettings : refreshedPrivateSettings }));
    }
    if (url === "/api/settings" && init?.method === "PATCH") {
      patches += 1;
      const body = JSON.parse(String(init.body));
      if (patches === 1) return Promise.reject(new TypeError("response lost"));
      expect(body).toEqual({ expectedVersion: 4, privacyAccepted: true, privacyProvider: "mock", privacyPolicyVersion: "2026-09-24" });
      return Promise.resolve(Response.json({ ok: true, data: acceptedSettings }));
    }
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences") {
      preferenceReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: preference }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);

  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法确认隐私确认是否已保存");
  await user.click(screen.getByRole("button", { name: "重新读取当前状态" }));

  const accept = await screen.findByRole("button", { name: "我已理解并继续" });
  expect(patches).toBe(1);
  expect(preferenceReads).toBe(0);
  await user.click(accept);
  expect(await screen.findByText("估时偏差 1.40×")).toBeInTheDocument();
  expect(patches).toBe(2);
  expect(preferenceReads).toBe(1);
});

it("finishes consent data loading when a received PATCH failure is later reconciled as accepted", async () => {
  const user = userEvent.setup();
  const privateSettings = { ...settings, privacyAcceptedAt: null };
  const acceptedSettings = { ...settings, version: 3 };
  let settingsReads = 0;
  let patches = 0;
  let preferenceReads = 0;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings" && !init?.method) {
      settingsReads += 1;
      if (settingsReads === 2) return Promise.reject(new TypeError("reconciliation read lost"));
      return Promise.resolve(Response.json({ ok: true, data: settingsReads === 1 ? privateSettings : acceptedSettings }));
    }
    if (url === "/api/settings" && init?.method === "PATCH") {
      patches += 1;
      return Promise.resolve(Response.json({ ok: false, error: { code: "VERSION_CONFLICT", message: "stale" } }, { status: 409 }));
    }
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/settings/preferences") {
      preferenceReads += 1;
      return Promise.resolve(Response.json({ ok: true, data: preference }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsPage />);

  await user.click(await screen.findByRole("button", { name: "我已理解并继续" }));
  const retry = await screen.findByRole("button", { name: "重新读取隐私确认" });
  expect(patches).toBe(1);
  expect(preferenceReads).toBe(0);
  await user.click(retry);

  expect(await screen.findByText("估时偏差 1.40×")).toBeInTheDocument();
  expect(patches).toBe(1);
  expect(preferenceReads).toBe(1);
});
