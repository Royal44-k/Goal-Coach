// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewGoalPage from "./page";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
const documentNavigate = vi.fn();
beforeEach(() => vi.stubGlobal("location", { assign: documentNavigate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const now = "2026-09-16T08:00:00+08:00";
const settings = {
  id: "44000000-0000-4000-8000-000000000001", createdAt: now, updatedAt: now, version: 2,
  privacyAcceptedAt: now, privacyProvider: "mock", privacyPolicyVersion: "2026-09-24", provider: "mock", model: "qwen3.7-flash-2026-07-15", fallbackEnabled: false,
  dailyInputTokenLimit: 100000, dailyOutputTokenLimit: 30000, apiKeyConfigured: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("never automatically repeats a creation with an unknown outcome", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals" && init?.method === "POST") return Promise.reject(new TypeError("lost create response"));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<NewGoalPage />);

  await user.click(await screen.findByRole("radio", { name: "学习目标" }));
  const message = screen.getByLabelText("告诉教练你的目标");
  await user.type(message, "四周内学会 TypeScript，每天一小时，做一个待办网页");
  await user.click(screen.getByRole("button", { name: "创建并开始澄清" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("创建目标没有查询编号");
  expect(message).toHaveValue("四周内学会 TypeScript，每天一小时，做一个待办网页");
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/goals" && init?.method === "POST")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "创建并开始澄清" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "仍要创建一个新目标" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "刷新目标列表" }));
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/goals" && init?.method === "POST")).toHaveLength(1);
  expect(message).toHaveValue("四周内学会 TypeScript，每天一小时，做一个待办网页");
  expect(screen.getByRole("button", { name: "仍要创建一个新目标" })).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "仍要创建一个新目标" }));
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/goals" && init?.method === "POST")).toHaveLength(2);
});

it("does not start the initial turn after the page unmounts during goal creation", async () => {
  const user = userEvent.setup();
  let finishCreate: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals" && init?.method === "POST") {
      return new Promise<Response>(resolve => { finishCreate = resolve; });
    }
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/agent/turn") return Promise.resolve(Response.json({ ok: true, data: {
      message: "继续", state: "clarifying", persistedChange: false,
      usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 },
    } }));
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<NewGoalPage />);
  await user.click(await screen.findByRole("radio", { name: "学习目标" }));
  await user.type(screen.getByLabelText("告诉教练你的目标"), "测试卸载");
  await user.click(screen.getByRole("button", { name: "创建并开始澄清" }));

  view.unmount();
  finishCreate?.(Response.json({ ok: true, data: { goal: {
    id: "44000000-0000-4000-8000-000000000010", ownerId: settings.id, createdAt: now, updatedAt: now,
    version: 1, title: "测试卸载", category: "learning", status: "draft", agentState: "intake",
    clarificationCount: 0, currentPlanVersionId: null, desiredOutcome: null, definitionOfDone: null,
    deadline: null, weeklyMinutes: null, constraints: null, motivation: null,
  }, state: "intake" } }));
  await Promise.resolve();

  expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(false);
  expect(pushMock).not.toHaveBeenCalled();
  expect(documentNavigate).not.toHaveBeenCalled();
});

it("does not navigate after the page unmounts while the initial turn is in flight", async () => {
  const user = userEvent.setup();
  const createdId = "44000000-0000-4000-8000-000000000020";
  let finishTurn: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals" && init?.method === "POST") return Promise.resolve(Response.json({ ok: true, data: { goal: {
      id: createdId, ownerId: settings.id, createdAt: now, updatedAt: now,
      version: 1, title: "测试转场", category: "learning", status: "draft", agentState: "intake",
      clarificationCount: 0, currentPlanVersionId: null, desiredOutcome: null, definitionOfDone: null,
      deadline: null, weeklyMinutes: null, constraints: null, motivation: null,
    }, state: "intake" } }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/agent/turn") return new Promise<Response>(resolve => { finishTurn = resolve; });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<NewGoalPage />);
  await user.click(await screen.findByRole("radio", { name: "学习目标" }));
  await user.type(screen.getByLabelText("告诉教练你的目标"), "测试转场");
  await user.click(screen.getByRole("button", { name: "创建并开始澄清" }));
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/turn")).toBe(true));

  view.unmount();
  finishTurn?.(Response.json({ ok: true, data: {
    message: "继续", state: "clarifying", persistedChange: false,
    usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 },
  } }));
  await Promise.resolve();

  expect(pushMock).not.toHaveBeenCalled();
  expect(documentNavigate).not.toHaveBeenCalled();
});

it.each([false, true])("uses a full same-origin document only after a received initial turn, unknown=%s", async unknown => {
  const user = userEvent.setup();
  const id = "44000000-0000-4000-8000-000000000030";
  let finishTurn: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") return Promise.resolve(Response.json({ ok: true, data: settings }));
    if (url === "/api/goals" && init?.method === "POST") return Promise.resolve(Response.json({ ok: true, data: { goal: {
      id, ownerId: settings.id, createdAt: now, updatedAt: now, version: 1, title: "持久化转场", category: "learning",
      status: "draft", agentState: "intake", clarificationCount: 0, currentPlanVersionId: null, desiredOutcome: null,
      definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null,
    }, state: "intake" } }));
    if (url === "/api/goals") return Promise.resolve(Response.json({ ok: true, data: [] }));
    if (url === "/api/agent/turn") return unknown ? Promise.reject(new TypeError("synthetic lost response"))
      : new Promise<Response>(resolve => { finishTurn = resolve; });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<NewGoalPage />);
  await user.click(await screen.findByRole("radio", { name: "学习目标" }));
  await user.type(screen.getByLabelText("告诉教练你的目标"), "已保存目标");
  await user.click(screen.getByRole("button", { name: "创建并开始澄清" }));
  expect(documentNavigate).not.toHaveBeenCalled();
  if (unknown) {
    expect(await screen.findByRole("heading", { name: "确认第一次澄清结果" })).toBeVisible();
    expect(documentNavigate).not.toHaveBeenCalled();
  } else {
    finishTurn?.(Response.json({ ok: true, data: { message: "已记录", state: "clarifying", persistedChange: false,
      usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 } } }));
    await vi.waitFor(() => expect(documentNavigate).toHaveBeenCalledExactlyOnceWith(`/goals/${id}`));
  }
  expect(pushMock).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/goals" && init?.method === "POST")).toHaveLength(1);
});
