import { expect, type Page } from "@playwright/test";

export const goalText = "四周内学会 TypeScript，每天一小时，做一个待办网页";
export const doneText = "待办网页可以新增、勾选完成和删除任务，刷新后仍保留记录。";
export const firstTaskTitle = "练习 TypeScript 基础类型";

export async function acceptPrivacyIfNeeded(page: Page) {
  const button = page.getByRole("button", { name: "我已理解并继续" });
  await expect(button.or(page.getByRole("radio", { name: "学习目标" }))).toBeVisible();
  if (await button.isVisible()) await button.click();
}

export async function createActiveGoal(page: Page) {
  await page.goto("/goals/new");
  await acceptPrivacyIfNeeded(page);
  await page.getByRole("radio", { name: "学习目标" }).check();
  await page.getByLabel("告诉教练你的目标").fill(goalText);
  await page.getByRole("button", { name: "创建并开始澄清" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}$/u);
  await expect(page.getByText(/为了形成可核对的完成标准/u)).toBeVisible();
  await page.getByLabel("告诉教练你的目标").fill(doneText);
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: /批准目标契约（草案 \d+ \/ 目标 \d+）/u }).click();
  await expect(page.getByRole("region", { name: "计划草案" })).toBeVisible();
  await page.getByRole("button", { name: /批准计划（草案 \d+ \/ 目标 \d+）/u }).click();
  await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
}
