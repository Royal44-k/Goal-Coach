import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("creates, reviews, approves, reloads, and opens the formal active goal", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  const requestCounts = { create: 0, agent: 0, approval: 0 };
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("request", request => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/goals") requestCounts.create += 1;
    if (pathname === "/api/agent/turn") requestCounts.agent += 1;
    if (pathname === "/api/approvals") requestCounts.approval += 1;
  });

  await page.goto("/goals/new");
  await expect(page.getByRole("heading", { name: "创建目标" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  const privacyAcceptance = page.getByRole("button", { name: "我已理解并继续" });
  await expect(privacyAcceptance.or(page.getByRole("radio", { name: "学习目标" }))).toBeVisible();
  if (await privacyAcceptance.isVisible()) await privacyAcceptance.click();

  await page.getByRole("radio", { name: "学习目标" }).check();
  await page.getByLabel("告诉教练你的目标").fill("四周内学会 TypeScript，每天一小时，做一个待办网页");
  await page.getByRole("button", { name: "创建并开始澄清" }).click();

  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/为了形成可核对的完成标准，待办网页需要具备哪些功能/)).toBeVisible();
  expect(requestCounts).toEqual({ create: 1, agent: 1, approval: 0 });
  await page.getByLabel("告诉教练你的目标").fill("待办网页可以新增、勾选完成和删除任务，刷新后仍保留记录。");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByRole("heading", { name: "目标契约" })).toBeVisible();
  const contractReview = page.getByRole("region", { name: "目标契约" });
  await expect(contractReview.getByText("待办网页可以新增、勾选完成和删除任务，刷新后仍保留记录。")).toBeVisible();
  expect(requestCounts).toEqual({ create: 1, agent: 2, approval: 0 });
  const beforeContractReload = { ...requestCounts };
  await page.reload();
  await expect(page.getByRole("heading", { name: "目标契约" })).toBeVisible();
  expect(requestCounts).toEqual(beforeContractReload);
  await page.getByRole("button", { name: /批准目标契约（草案 \d+ \/ 目标 \d+）/ }).click();

  await expect(page.getByRole("heading", { name: "计划草案" })).toBeVisible();
  await expect(page.locator(".plan-task-card")).toHaveCount(3);
  expect(requestCounts).toEqual({ create: 1, agent: 3, approval: 1 });
  const reviewText = await page.getByRole("region", { name: "计划草案" }).textContent();
  expect(reviewText?.indexOf("里程碑")).toBeLessThan(reviewText?.indexOf("任务") ?? -1);
  const beforePlanReload = { ...requestCounts };
  await page.reload();
  await expect(page.getByRole("heading", { name: "计划草案" })).toBeVisible();
  await expect(page.getByText("验证刷新后的记录保留")).toBeVisible();
  expect(requestCounts).toEqual(beforePlanReload);
  await page.getByRole("button", { name: /批准计划（草案 \d+ \/ 目标 \d+）/ }).click();

  await expect(page.getByText("进行中")).toBeVisible();
  await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
  await expect(page.locator(".current-task-list li")).toHaveCount(3);
  expect(requestCounts).toEqual({ create: 1, agent: 3, approval: 2 });
  const beforeActiveReload = { ...requestCounts };
  await page.reload();
  await expect(page.getByText("进行中")).toBeVisible();
  await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
  await expect(page.locator(".current-task-list li")).toHaveCount(3);
  expect(requestCounts).toEqual(beforeActiveReload);

  await page.screenshot({ path: testInfo.outputPath("active-workspace-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText("进行中")).toBeVisible();
  await expect(page.getByRole("link", { name: "自适应目标教练" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const undersizedTargets = await page.locator("a[href], button, input, textarea, summary").evaluateAll(elements => elements.flatMap(element => {
    if (element.classList.contains("skip-link")) return [];
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const visible = style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < innerHeight
      && rect.left < innerWidth;
    if (!visible || (rect.width >= 44 && rect.height >= 44)) return [];
    return [{ label: target.getAttribute("aria-label") ?? target.textContent?.trim() ?? target.tagName, width: rect.width, height: rect.height }];
  }));
  expect(undersizedTargets).toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  await page.screenshot({ path: testInfo.outputPath("active-workspace-mobile.png"), fullPage: true });
  expect(browserErrors).toEqual([]);
});
