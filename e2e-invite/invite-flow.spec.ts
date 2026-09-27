import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createActiveGoal } from "../e2e/helpers/goal-fixtures";

async function register(page: Page, username: string, invite: string, password = `Synthetic-${randomUUID()}`) {
  await page.goto("/login");
  await page.getByRole("button", { name: "使用邀请注册" }).click();
  await page.getByLabel("账号名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("邀请码", { exact: true }).fill(invite);
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByText(`当前账号：${username}`, { exact: true })).toBeVisible();
}

test("invite registration, private goals, logout and offline readiness at 375px", async ({ browser, baseURL }, testInfo) => {
  const unexpected: Record<string, string | number | boolean>[] = [];
  const navigationLifecycle: Record<string, string | number | boolean>[] = [];
  let phase = "start";
  let sequence = 0;
  let modelRequests = 0;
  let requestSequence = 0;
  let workspaceStep = "not-started";
  let approvalRequests = 0;
  const requestStarts = new WeakMap<Request, Record<string, string | number | boolean>>();
  // Preserve route shape only: no UUIDs, queries, origins, arbitrary path values or raw headers.
  const publicSegments = new Set(["", "api", "auth", "session", "register", "login", "logout", "admin", "users", "invites", "goals", "new", "settings", "preferences", "model-readiness", "agent", "turn", "approvals", "tasks", "_next", "static", "chunks", "icons", "favicon.ico", "icon.svg", "sw.js", "manifest.webmanifest"]);
  const routeTemplate = (request: Request) => new URL(request.url()).pathname.split("/").map(segment => publicSegments.has(segment) ? segment : ":segment").join("/");
  const routeShape = (url: string) => new URL(url).pathname.split("/").map(segment => publicSegments.has(segment) ? segment : ":segment").join("/");
  const isGoalFlight = (url: string, method: string, rsc: boolean) => method === "GET" && rsc && /^\/goals\/[^/]+$/u.test(new URL(url).pathname);
  const contentTypeKind = (value: string | undefined) => value?.startsWith("text/x-component")
    ? "text/x-component" : value?.startsWith("text/html") ? "text/html" : "other";
  const initiatorKind = (value: string | undefined) => value === "parser" || value === "script" || value === "preload" ? value : "other";
  const startedAt = Date.now();
  const lifecycle = (kind: string, extras: Record<string, string | number | boolean> = {}) => {
    navigationLifecycle.push({ kind, elapsedMs: Date.now() - startedAt, phase, workspaceStep, ...extras });
  };
  const diagnostic = (kind: string, extras: Record<string, string | number | boolean> = {}) => {
    unexpected.push({ kind, phase, sequence: ++sequence, elapsedMs: Date.now() - startedAt, ...extras });
  };
  const contexts: BrowserContext[] = [];
  async function observedPage() {
    const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 }, serviceWorkers: "block" });
    contexts.push(context);
    const pageId = contexts.length;
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === baseURL) return route.continue();
      diagnostic("external-request", { method: route.request().method(), resourceType: route.request().resourceType(), navigation: route.request().isNavigationRequest() });
      return route.abort();
    });
    const page = await context.newPage();
    if (pageId === 2) {
      const cdp = await context.newCDPSession(page);
      const flightRequests = new Map<string, number>();
      let flightSequence = 0;
      cdp.on("Network.requestWillBeSent", event => {
        const request = event.request as { url: string; method: string; headers: Record<string, string> };
        const rsc = Object.entries(request.headers).some(([name, value]) => name.toLowerCase() === "rsc" && value === "1");
        if (!isGoalFlight(request.url, request.method, rsc || new URL(request.url).searchParams.has("_rsc"))) return;
        const cdpId = ++flightSequence;
        flightRequests.set(event.requestId, cdpId);
        lifecycle("cdp-request", { cdpId, routeTemplate: routeShape(request.url),
          initiatorType: initiatorKind(event.initiator?.type) });
      });
      cdp.on("Network.responseReceived", event => {
        const cdpId = flightRequests.get(event.requestId);
        if (cdpId !== undefined) lifecycle("cdp-response", { cdpId, status: event.response.status,
          contentType: contentTypeKind(event.response.mimeType) });
      });
      cdp.on("Network.loadingFinished", event => {
        const cdpId = flightRequests.get(event.requestId);
        if (cdpId !== undefined) { lifecycle("cdp-finished", { cdpId }); flightRequests.delete(event.requestId); }
      });
      cdp.on("Network.loadingFailed", event => {
        const cdpId = flightRequests.get(event.requestId);
        if (cdpId !== undefined) { lifecycle("cdp-failed", { cdpId, canceled: event.canceled ?? false,
          errorCode: event.errorText?.match(/ERR_[A-Z_]+/u)?.[0] ?? "OTHER" }); flightRequests.delete(event.requestId); }
      });
      await cdp.send("Network.enable");
      page.on("framenavigated", frame => {
        if (frame === page.mainFrame()) lifecycle("main-frame-navigation", { routeTemplate: routeShape(frame.url()) });
      });
    }
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (pageId === 2 && phase === "member-workspace" && request.isNavigationRequest()
        && request.method() === "GET" && /^\/goals\/[^/]+$/u.test(pathname) && pathname !== "/goals/new")
        lifecycle("created-goal-document-request", { routeTemplate: routeTemplate(request) });
      if (pathname === "/api/agent/turn") modelRequests++;
      if (phase === "member-workspace") {
        if (pathname === "/goals/new") workspaceStep = "open-goal-form";
        else if (pathname === "/api/goals" && request.method() === "POST") workspaceStep = "create-goal";
        else if (pathname === "/api/agent/turn" && request.method() === "POST") workspaceStep = `agent-turn-${modelRequests}`;
        else if (pathname === "/api/approvals" && request.method() === "POST") workspaceStep = `approval-${++approvalRequests}`;
      }
      requestStarts.set(request, { pageId, requestId: ++requestSequence, routeTemplate: routeTemplate(request), startPhase: phase, startWorkspaceStep: workspaceStep, startElapsedMs: Date.now() - startedAt, rsc: request.headers()["rsc"] === "1", prefetch: request.headers()["next-router-prefetch"] === "1" });
      if (pageId === 2 && isGoalFlight(request.url(), request.method(), request.headers()["rsc"] === "1"))
        lifecycle("pw-request", { requestId: requestSequence, routeTemplate: routeTemplate(request),
          routerPrefetchHeader: request.headers()["next-router-prefetch"] === "1",
          segmentPrefetchHeader: Object.hasOwn(request.headers(), "next-router-segment-prefetch") });
    });
    page.on("pageerror", () => diagnostic("page-error"));
    page.on("console", message => { if (message.type() === "error") diagnostic("console-error"); });
    page.on("requestfailed", request => {
      if (pageId === 2 && isGoalFlight(request.url(), request.method(), request.headers()["rsc"] === "1"))
        lifecycle("pw-failed", { requestId: Number(requestStarts.get(request)?.requestId ?? -1),
          errorCode: request.failure()?.errorText?.match(/ERR_[A-Z_]+/u)?.[0] ?? "OTHER" });
      diagnostic("request-failed", {
        ...requestStarts.get(request), pageId, routeTemplate: routeTemplate(request), failPhase: phase, workspaceStep,
        method: request.method(), resourceType: request.resourceType(), navigation: request.isNavigationRequest(),
        errorCode: request.failure()?.errorText?.match(/ERR_[A-Z_]+/)?.[0] ?? "OTHER",
      });
    });
    page.on("requestfinished", request => {
      if (pageId === 2 && isGoalFlight(request.url(), request.method(), request.headers()["rsc"] === "1"))
        lifecycle("pw-finished", { requestId: Number(requestStarts.get(request)?.requestId ?? -1) });
    });
    page.on("response", response => {
      const request = response.request();
      if (pageId === 2 && request.method() === "POST" && new URL(request.url()).pathname === "/api/agent/turn")
        lifecycle("agent-turn-response", { status: response.status(), turn: modelRequests });
      if (pageId === 2 && isGoalFlight(request.url(), request.method(), request.headers()["rsc"] === "1")
        && response.status() >= 200 && response.status() < 400)
        lifecycle("pw-response", { requestId: Number(requestStarts.get(request)?.requestId ?? -1),
          status: response.status(), contentType: contentTypeKind(response.headers()["content-type"]) });
      if (response.status() >= 400) diagnostic("http-error", {
        ...requestStarts.get(request), pageId, routeTemplate: routeTemplate(request),
        status: response.status(), method: request.method(), resourceType: request.resourceType(), navigation: request.isNavigationRequest(),
      });
    });
    return page;
  }
  async function screenshot(page: Page, name: string) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
  }
  try {
    phase = "admin-login";
    const admin = await observedPage();
    await admin.goto("/login");
    await expect(admin.getByRole("heading", { name: "账号登录" })).toBeVisible();
    const usernameInput = admin.getByLabel("账号名", { exact: true });
    for (const [value, valid] of [["Abc_123-test", true], ["invalid.name", false], ["中文账号", false]] as const) {
      await usernameInput.fill(value);
      expect(await usernameInput.evaluate(input => (input as HTMLInputElement).checkValidity())).toBe(valid);
    }
    await usernameInput.clear();
    await screenshot(admin, "login-mobile.png");
    const bootstrap = process.env.GOAL_COACH_E2E_ADMIN_INVITE;
    if (!bootstrap) throw new Error("Missing synthetic bootstrap invite");
    const adminPassword = process.env.GOAL_COACH_E2E_ADMIN_PASSWORD;
    if (!adminPassword) throw new Error("Missing synthetic admin password");
    await register(admin, "acceptance_admin", bootstrap, adminPassword);
    phase = "admin-invitation";
    await admin.getByRole("link", { name: "邀请与账号" }).click();
    await admin.getByRole("button", { name: "创建普通邀请" }).click();
    const token = await admin.locator(".invite-code").textContent();
    if (!token) throw new Error("Member invitation was not created");
    // Navigate away before capturing any administrator screen: token appears only once.
    await admin.reload();
    await expect(admin.locator(".invite-code")).toHaveCount(0);
    await expect(admin.getByRole("heading", { name: "账号", exact: true })).toBeVisible();
    await screenshot(admin, "admin-mobile.png");

    phase = "member-registration";
    const member = await observedPage();
    await register(member, "acceptance_member", token);
    await expect(member.getByRole("link", { name: "邀请与账号" })).toHaveCount(0);
    phase = "member-workspace";
    await createActiveGoal(member);
    expect(navigationLifecycle.filter(event => event.kind === "created-goal-document-request")).toHaveLength(1);
    expect(navigationLifecycle.filter(event => event.kind === "pw-request" && event.workspaceStep === "agent-turn-1")).toEqual([]);
    const goalId = new URL(member.url()).pathname.split("/").at(-1)!;
    await screenshot(member, "member-workspace-mobile.png");
    const own = await member.request.get(`/api/goals/${goalId}`);
    expect(own.status()).toBe(200);
    const memberList = await member.request.get("/api/goals");
    expect((await memberList.json()).data).toHaveLength(1);
    const adminList = await admin.request.get("/api/goals");
    expect((await adminList.json()).data).toEqual([]);
    await admin.goto("/");
    await expect(admin.locator(`a[href="/goals/${goalId}"]`)).toHaveCount(0);
    // Intentional denials use the context API client: keep them out of browser error diagnostics.
    const crossRead = await admin.request.get(`/api/goals/${goalId}`);
    expect(crossRead.status()).toBe(404);
    const memberAdmin = await member.request.get("/api/admin/users");
    expect(memberAdmin.status()).toBe(403);

    phase = "member-settings";
    await member.goto("/settings");
    const readinessResponse = member.waitForResponse(response => response.url().endsWith("/api/settings/model-readiness"));
    await member.getByRole("button", { name: "检查模型配置" }).click();
    expect((await (await readinessResponse).json()).data).toMatchObject({ provider: "mock", configured: false, liveVerified: false, status: "mock_selected" });
    await expect(member.getByRole("region", { name: "服务器配置检查" }).getByRole("status")).toContainText("未验证模型供应商连接");
    await expect(member.getByText("当前未连接模型，对话使用预设流程。", { exact: true })).toBeVisible();
    await screenshot(member, "settings-mobile.png");

    phase = "member-withdrawal";
    const modelRequestsBeforeWithdrawal = modelRequests;
    await member.getByRole("button", { name: "撤回模型数据使用同意" }).click();
    await expect(member.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
    await member.goto(`/goals/${goalId}`);
    await expect(member.getByRole("button", { name: "开始这个任务" })).toBeEnabled();
    const taskTitle = await member.locator(".current-action-card h3").textContent();
    if (!taskTitle) throw new Error("Missing synthetic approved task");
    await member.getByRole("button", { name: "开始这个任务" }).click();
    await expect(member.locator(".task-board__item").filter({ hasText: taskTitle }).locator(".task-board__title span")).toHaveText("进行中");
    expect(modelRequests).toBe(modelRequestsBeforeWithdrawal);

    phase = "member-logout";
    const priorCookies = await member.context().cookies();
    await member.getByRole("button", { name: "退出登录" }).click();
    await expect(member.getByRole("heading", { name: "账号登录" })).toBeVisible();
    expect((await member.request.get("/api/goals")).status()).toBe(401);
    // Restore the pre-logout cookie deliberately: server-side invalidation must still deny it.
    await member.context().addCookies(priorCookies);
    expect((await member.request.get(`/api/goals/${goalId}`)).status()).toBe(401);
    expect((await admin.request.get("/api/goals")).status()).toBe(200);
    await screenshot(member, "logout-mobile.png");
    expect(unexpected).toEqual([]);
  } finally {
    await testInfo.attach("browser-evidence", { body: JSON.stringify({ unexpected, navigationLifecycle, phase, modelRequests, intentionalDenials: [404, 403, 401, 401], viewport: "375x812", readinessConfigured: false, liveVerified: false }), contentType: "application/json" });
    await Promise.all(contexts.map(context => context.close()));
  }
});
