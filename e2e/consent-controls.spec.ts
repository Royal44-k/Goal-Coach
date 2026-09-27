import { expect, test } from "@playwright/test";

test("local provider controls remain available before cloud consent at 375px", async ({ page, baseURL }, testInfo) => {
  let modelRequests = 0;
  const unexpected: string[] = [];
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    unexpected.push("external browser request");
    return route.abort();
  });
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/agent/turn") modelRequests++; });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
  await page.getByLabel("模型提供方").selectOption("deepseek");
  await page.getByRole("button", { name: /保存模型设置/ }).click();
  await expect(page.getByLabel("模型提供方")).toHaveValue("deepseek");
  await expect(page.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
  await expect(page.getByRole("button", { name: /保存模型设置/ })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("deepseek-consent-controls-375.png"), fullPage: true });
  await page.getByLabel("模型提供方").selectOption("mock");
  await page.getByRole("button", { name: /保存模型设置/ }).click();
  await expect(page.getByLabel("模型提供方")).toHaveValue("mock");
  await expect(page.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
  expect(modelRequests).toBe(0);
  expect(unexpected).toEqual([]);
});
