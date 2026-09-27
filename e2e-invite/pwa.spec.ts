import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
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

async function prepareSyntheticAdmin(page: Page) {
  const password = process.env.GOAL_COACH_E2E_ADMIN_PASSWORD;
  if (!password) throw new Error("Missing synthetic admin password");
  // The invitation story may already have consumed the one-use bootstrap invite.
  // This story also needs to run alone against a fresh isolated database.
  await page.goto("/login");
  const login = await page.request.post("/api/auth/login", { headers: { Origin: new URL(page.url()).origin }, data: { username: "acceptance_admin", password } });
  if (login.status() === 200) {
    await page.goto("/");
  } else if (login.status() === 401) {
    const bootstrap = process.env.GOAL_COACH_E2E_ADMIN_INVITE;
    if (!bootstrap) throw new Error("Missing synthetic bootstrap invite");
    await register(page, "acceptance_admin", bootstrap, password);
  } else {
    throw new Error(`Unexpected synthetic admin login status: ${login.status()}`);
  }
  await expect(page.getByText("当前账号：acceptance_admin", { exact: true })).toBeVisible();
}

async function expectPublicOnlyCache(page: Page) {
  const entries = await page.evaluate(async () => {
    const names = await caches.keys();
    return Promise.all(names.map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname) })));
  });
  expect(entries).toEqual([{ name: "goal-coach-offline-v1", urls: ["/offline.html"] }]);
}

test("production PWA uses only public offline cache across two invited accounts", async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  const unexpected: string[] = [];
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    unexpected.push("external browser request");
    return route.abort();
  });
  page.on("pageerror", error => unexpected.push(`page: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") unexpected.push(`console: ${message.text()}`); });
  try {
    await prepareSyntheticAdmin(page);
    const manifestLink = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestLink).toBeTruthy();
    const manifestResponse = await page.request.get(manifestLink!);
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json();
    expect(manifest).toMatchObject({ name: "Goal Coach", short_name: "Goal Coach", id: "/", start_url: "/", display: "standalone" });
    const appleLink = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    expect(appleLink).toBe("/icons/apple-touch-icon-180.png");
    const appleIcon = await page.request.get(appleLink!);
    expect(appleIcon.ok()).toBe(true);
    expect(appleIcon.headers()["content-type"]).toContain("image/png");
    const appleBytes = await appleIcon.body();
    expect([...appleBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(appleBytes.readUInt32BE(16)).toBe(180);
    expect(appleBytes.readUInt32BE(20)).toBe(180);
    for (const size of [192, 512]) {
      const icon = await page.request.get(`/icons/icon-${size}.png`);
      expect(icon.ok()).toBe(true);
      expect(icon.headers()["content-type"]).toContain("image/png");
    }
    const worker = await page.request.get("/sw.js");
    expect(worker.ok()).toBe(true);
    expect(worker.headers()["cache-control"]).toContain("no-store");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await expect(page.getByRole("button", { name: "刷新页面" })).toHaveCount(0);
    await expectPublicOnlyCache(page);
    await page.getByRole("link", { name: "邀请与账号" }).click();
    await page.getByRole("button", { name: "创建普通邀请" }).click();
    const token = await page.locator(".invite-code").textContent();
    if (!token) throw new Error("Synthetic member invitation missing");
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("heading", { name: "账号登录" })).toBeVisible();
    await expectPublicOnlyCache(page);
    expect(unexpected).toEqual([]);

    await register(page, "pwa_member", token);
    await createActiveGoal(page);
    await expectPublicOnlyCache(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("pwa-member-375.png") });
    await context.setOffline(true);
    await page.goto("/goals/offline-check");
    await expect(page.getByRole("heading", { name: "当前离线，请联网后继续" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("pwa-offline-375.png"), fullPage: true });
    await context.setOffline(false);
    await page.goto("/settings");
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("heading", { name: "账号登录" })).toBeVisible();
    await expectPublicOnlyCache(page);
    expect(unexpected).toEqual([]);
  } finally {
    await context.close();
  }
});
