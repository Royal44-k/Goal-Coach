// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";
import { AuthGate } from "./auth-gate";
import { AdminPanel } from "./admin-panel";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("supports account autofill, password visibility, invite registration and generic failure", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", async () => Response.json({ ok: false, error: { code: "AUTH_INVALID_CREDENTIALS", message: "账号或密码无效。" } }, { status: 401 }));
  render(<LoginForm />);
  expect(screen.getByLabelText("账号名")).toHaveAttribute("autocomplete", "username");
  expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "current-password");
  await user.type(screen.getByLabelText("账号名"), "alice"); await user.type(screen.getByLabelText("密码"), "synthetic password");
  await user.click(screen.getByRole("button", { name: "显示密码" }));
  expect(screen.getByLabelText("密码")).toHaveAttribute("type", "text");
  await user.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("账号或密码无效。");
  await user.click(screen.getByRole("button", { name: "使用邀请注册" }));
  expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "new-password");
  expect(screen.getByLabelText("邀请码")).toHaveAttribute("autocomplete", "off");
});
it("fails closed while session is loading or unavailable, then removes private UI on expiry", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", () => new Promise<Response>(done => { resolve = done; }));
  render(<AuthGate><p>Alice private content</p></AuthGate>);
  expect(screen.queryByText("Alice private content")).not.toBeInTheDocument();
  resolve(Response.json({ ok: true, data: { mode: "invite", actor: { ownerId: "11111111-1111-4111-8111-111111111111", username: "alice", role: "member" } } }));
  expect(await screen.findByText("Alice private content")).toBeInTheDocument();
  window.dispatchEvent(new Event("goal-coach-auth-required"));
  await waitFor(() => expect(screen.queryByText("Alice private content")).not.toBeInTheDocument());
  expect(screen.getByLabelText("密码")).toBeInTheDocument();
});
it("does not fall back to local mode when session request fails", async () => {
  vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
  render(<AuthGate><p>private</p></AuthGate>);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法确认登录状态");
  expect(screen.queryByText("private")).not.toBeInTheDocument();
});
it("ignores a stale successful session response after expiry", async () => {
  const actor = { ownerId: "11111111-1111-4111-8111-111111111111", username: "alice", role: "member" };
  let resolve!: (value: Response) => void, calls = 0;
  vi.stubGlobal("fetch", () => ++calls === 1 ? Promise.resolve(Response.json({ ok: true, data: { mode: "invite", actor } })) : new Promise<Response>(done => { resolve = done; }));
  render(<AuthGate><p>private</p></AuthGate>); await screen.findByText("private");
  window.dispatchEvent(new Event("focus")); await waitFor(() => expect(resolve).toBeDefined());
  window.dispatchEvent(new Event("goal-coach-auth-required"));
  await screen.findByLabelText("密码");
  resolve(Response.json({ ok: true, data: { mode: "invite", actor } }));
  await new Promise(done => setTimeout(done, 10));
  expect(screen.queryByText("private")).not.toBeInTheDocument();
});
it("keeps an unsaved form through same-account focus revalidation", async () => {
  const user = userEvent.setup(); const actor = { ownerId: "11111111-1111-4111-8111-111111111111", username: "alice", role: "member" };
  vi.stubGlobal("fetch", async () => Response.json({ ok: true, data: { mode: "invite", actor } }));
  render(<AuthGate><label>Draft<input defaultValue="" /></label></AuthGate>);
  await user.type(await screen.findByLabelText("Draft"), "unsaved");
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(screen.getByLabelText("Draft")).toBeVisible());
  expect(screen.getByLabelText("Draft")).toHaveValue("unsaved");
});
it.each(["focus", "pageshow", "visibilitychange"])("keeps the same local-mode form node while %s revalidation is pending", async event => {
  const user = userEvent.setup();
  let completeSecond!: (value: Response) => void;
  let calls = 0;
  vi.stubGlobal("fetch", () => ++calls === 1
    ? Promise.resolve(Response.json({ ok: true, data: { mode: "local", actor: null } }))
    : new Promise<Response>(resolve => { completeSecond = resolve; }));
  render(<AuthGate><label>Draft<input defaultValue="" /></label></AuthGate>);
  const input = await screen.findByLabelText("Draft");
  await user.type(input, "unsaved local text");
  if (event === "visibilitychange") document.dispatchEvent(new Event(event));
  else window.dispatchEvent(new Event(event));
  await waitFor(() => expect(completeSecond).toBeDefined());
  expect(screen.getByLabelText("Draft")).toBe(input);
  expect(input).toHaveValue("unsaved local text");
  completeSecond(Response.json({ ok: true, data: { mode: "local", actor: null } }));
  await waitFor(() => expect(screen.getByLabelText("Draft")).toBeVisible());
  expect(screen.getByLabelText("Draft")).toBe(input);
  expect(input).toHaveValue("unsaved local text");
});
it.each(["session_error", "expired", "owner_switch"] as const)("fails closed for local revalidation %s", async outcome => {
  const user = userEvent.setup();
  let completeSecond!: (value: Response) => void, failSecond!: (error: Error) => void;
  let calls = 0;
  const actor = { ownerId: "22222222-2222-4222-8222-222222222222", username: "bob", role: "member" };
  vi.stubGlobal("fetch", () => ++calls === 1
    ? Promise.resolve(Response.json({ ok: true, data: { mode: "local", actor: null } }))
    : new Promise<Response>((resolve, reject) => { completeSecond = resolve; failSecond = reject; }));
  render(<AuthGate><label>Draft<input defaultValue="" /></label></AuthGate>);
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  const input = await screen.findByLabelText("Draft");
  await user.type(input, "unsaved local text");
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(completeSecond).toBeDefined());
  expect(screen.getByLabelText("Draft")).toBe(input);
  if (outcome === "session_error") failSecond(new Error("offline"));
  else completeSecond(Response.json({ ok: true, data: { mode: "invite", actor: outcome === "expired" ? null : actor } }));
  if (outcome === "session_error") {
    expect(await screen.findByRole("alert")).toHaveTextContent("无法确认登录状态");
    expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  } else if (outcome === "expired") {
    await screen.findByLabelText("密码");
    expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  } else {
    await waitFor(() => expect(screen.getByLabelText("Draft")).not.toBe(input));
    expect(input).not.toBeInTheDocument();
    expect(screen.getByLabelText("Draft")).toHaveValue("");
  }
});
it("requires confirmation before disabling an account and retains the one-time invitation visibly", async () => {
  const user = userEvent.setup(); const changes: string[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    let data: unknown = [];
    if (path.endsWith("users")) data = [{ ownerId: "11111111-1111-4111-8111-111111111111", username: "alice", role: "member", disabledAt: null, createdAt: 1 }];
    if (init.method === "PATCH") { changes.push("disabled"); data = null; }
    if (init.method === "POST") data = { id: "22222222-2222-4222-8222-222222222222", token: "synthetic-visible-invite", expiresAt: Date.now() + 10000 };
    return Response.json({ ok: true, data });
  });
  render(<AdminPanel />);
  await user.click(await screen.findByRole("button", { name: "禁用 alice" })); expect(changes).toEqual([]);
  await user.click(screen.getByRole("button", { name: "确认禁用" })); await waitFor(() => expect(changes).toEqual(["disabled"]));
  await user.click(screen.getByRole("button", { name: "创建普通邀请" }));
  expect(await screen.findByText("synthetic-visible-invite")).toBeInTheDocument();
});
