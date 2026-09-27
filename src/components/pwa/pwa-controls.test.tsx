// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PWAControls, PWAProvider } from "./pwa-controls";

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
const originalMatchMedia = window.matchMedia;
const originalOnline = Object.getOwnPropertyDescriptor(navigator, "onLine");
function media(matches: boolean): MediaQueryList {
  return {
    matches, media: "(display-mode: standalone)", onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  };
}

function setNavigator(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value });
}

function serviceWorker(waiting: { postMessage: ReturnType<typeof vi.fn> } | null = null) {
  const events = new EventTarget();
  const registration = {
    waiting,
    installing: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const listeners = {
    addEventListener: vi.fn((name: string, listener: EventListener) => events.addEventListener(name, listener)),
    removeEventListener: vi.fn((name: string, listener: EventListener) => events.removeEventListener(name, listener)),
  };
  const register = vi.fn(async () => registration);
  setNavigator("serviceWorker", { register, ...listeners });
  return { registration, register, listeners, events };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  setNavigator("userAgent", "Edge on Windows");
  setNavigator("onLine", true);
  window.matchMedia = vi.fn(() => media(false));
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  for (const [name, descriptor] of [["serviceWorker", originalServiceWorker], ["userAgent", originalUserAgent], ["onLine", originalOnline]] as const) {
    if (descriptor) Object.defineProperty(navigator, name, descriptor);
    else Reflect.deleteProperty(navigator, name);
  }
  window.matchMedia = originalMatchMedia;
});

function mount() { return render(<PWAProvider><PWAControls /></PWAProvider>); }

it("guides Android embedded browsers to open a system browser without an install prompt", async () => {
  serviceWorker();
  setNavigator("userAgent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 MicroMessenger/8.0.49");
  mount();
  expect(await screen.findByText(/系统浏览器/)).toHaveTextContent("复制链接");
  expect(screen.queryByText(/浏览器菜单中选择/)).not.toBeInTheDocument();
});

it("keeps ordinary Android browser install guidance", async () => {
  serviceWorker();
  setNavigator("userAgent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36");
  mount();
  expect(await screen.findByText(/浏览器菜单中选择/)).toBeInTheDocument();
});

it("shows a real install action only after beforeinstallprompt and cleans listeners", async () => {
  const sw = serviceWorker();
  const prompt = vi.fn(async () => undefined);
  const remove = vi.spyOn(window, "removeEventListener");
  const { unmount } = mount();
  expect(screen.queryByRole("button", { name: "添加到主屏幕" })).not.toBeInTheDocument();
  const event = new Event("beforeinstallprompt") as Event & { prompt: typeof prompt; preventDefault: () => void };
  event.prompt = prompt;
  event.preventDefault = vi.fn();
  fireEvent(window, event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "添加到主屏幕" }));
  expect(prompt).toHaveBeenCalledOnce();
  await waitFor(() => expect(sw.register).toHaveBeenCalledWith("/sw.js", { updateViaCache: "none" }));
  unmount();
  expect(remove).toHaveBeenCalledWith("beforeinstallprompt", expect.any(Function));
  remove.mockRestore();
});

it("gives iOS instructions and suppresses installation in standalone display", async () => {
  serviceWorker();
  setNavigator("userAgent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1");
  const { unmount } = mount();
  expect(await screen.findByText(/Safari.*分享.*添加到主屏幕/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "添加到主屏幕" })).not.toBeInTheDocument();
  unmount();
  window.matchMedia = vi.fn(() => media(true));
  mount();
  await waitFor(() => expect(screen.queryByText(/添加到主屏幕/)).not.toBeInTheDocument());
});

it("tells users in an iOS embedded browser to open Safari first", async () => {
  serviceWorker();
  setNavigator("userAgent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.49 Safari/604.1");
  mount();
  expect(await screen.findByText(/在 Safari 中打开/)).toBeInTheDocument();
  expect(screen.queryByText(/Safari 中点“分享”/)).not.toBeInTheDocument();
});

it("shows offline state and unsupported browser guidance without a false action", () => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  mount();
  expect(screen.getByText(/浏览器菜单/)).toBeInTheDocument();
  setNavigator("onLine", false);
  fireEvent.offline(window);
  expect(screen.getByRole("status")).toHaveTextContent("当前离线，请联网后继续");
  expect(screen.queryByRole("button", { name: "添加到主屏幕" })).not.toBeInTheDocument();
});

it("waits for explicit update and explicit refresh, warning about unsaved input", async () => {
  const waiting = { postMessage: vi.fn() };
  const sw = serviceWorker(waiting);
  const { unmount } = mount();
  const update = await screen.findByRole("button", { name: /保存当前内容后更新/ });
  expect(waiting.postMessage).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("有新版本，可在保存当前内容后更新");
  fireEvent.click(update);
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  expect(screen.queryByRole("button", { name: "刷新页面" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("正在启用新版本");
  act(() => { sw.events.dispatchEvent(new Event("controllerchange")); });
  expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("未保存的输入会丢失");
  unmount();
  expect(sw.listeners.removeEventListener).toHaveBeenCalledWith("controllerchange", expect.any(Function));
});

it("does not announce an update when first installation takes control", async () => {
  const sw = serviceWorker();
  mount();
  await waitFor(() => expect(sw.register).toHaveBeenCalledOnce());
  act(() => { sw.events.dispatchEvent(new Event("controllerchange")); });
  expect(screen.queryByRole("button", { name: "刷新页面" })).not.toBeInTheDocument();
  expect(screen.queryByText(/新版本已就绪/)).not.toBeInTheDocument();
});
