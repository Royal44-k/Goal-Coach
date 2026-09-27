import { expect, test, type Page } from "@playwright/test";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createActiveGoal } from "./helpers/goal-fixtures";

async function selectHarnessProvider(page: Page, provider: "mock" | "qwen") {
  const result = await page.evaluate(async selected => {
    const settings = await (await fetch("/api/settings", { cache: "no-store" })).json();
    if (!settings.ok || settings.data.apiKeyConfigured) throw new Error("Requires isolated no-key harness settings");
    const response = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: settings.data.version, provider: selected }) });
    return { status: response.status, payload: await response.json() };
  }, provider);
  expect(result).toMatchObject({ status: 200, payload: { ok: true, data: { provider, apiKeyConfigured: false } } });
}

test("last unfinished leaf deletion exposes review, and no-key reflection failure recovers through reload and explicit retry", async ({ page }) => {
  const configured = process.env.GOAL_COACH_E2E_DATABASE_PATH;
  if (!configured) throw new Error("Requires the owned GUID E2E database");
  const path = resolve(configured);
  expect(basename(path)).toBe("goal-coach.db");
  expect(dirname(dirname(path))).toBe(resolve(tmpdir()));
  expect(basename(dirname(path))).toMatch(/^goal-coach-e2e-[0-9a-f-]{36}$/i);
  await createActiveGoal(page);
  const board = page.getByRole("region", { name: "任务" });
  for (let index = 0; index < 2; index++) {
    const task = board.locator(".task-board__item").nth(index);
    const title = (await task.getByRole("heading").textContent())!.trim();
    await task.getByRole("button", { name: `完成：${title}` }).click();
    const dialog = page.getByRole("dialog", { name: `完成任务：${title}` });
    await dialog.getByLabel("文字说明").fill(`已验证：${title}`);
    await dialog.getByRole("button", { name: "确认完成并保存证据" }).click();
    await expect(dialog).not.toBeVisible();
  }
  const last = board.locator(".task-board__item").nth(2);
  const title = (await last.getByRole("heading").textContent())!.trim();
  await last.getByRole("button", { name: `删除：${title}` }).click();
  const deletion = page.getByRole("dialog", { name: `删除任务：${title}` });
  await deletion.getByRole("textbox").fill(title);
  await deletion.getByRole("button", { name: "确认删除任务" }).click();
  await expect(page.getByRole("heading", { name: "核对当前执行记录" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "核对当前执行记录" })).toBeVisible();
  const completionRefusal = await page.evaluate(async () => {
    const url = `/api${location.pathname}`;
    const before = (await (await fetch(url, { cache: "no-store" })).json()).data.goal;
    const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed", expectedVersion: before.version, operationId: crypto.randomUUID() }) });
    const payload = await response.json();
    const after = (await (await fetch(url, { cache: "no-store" })).json()).data.goal;
    return { status: response.status, payload, before, after };
  });
  expect(completionRefusal).toMatchObject({ status: 409, payload: { ok: false, error: { code: "INVALID_TRANSITION" } } });
  expect(completionRefusal.after).toEqual(completionRefusal.before);
  try {
    await selectHarnessProvider(page, "qwen");
    await page.reload();
    await expect(page.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
    await page.getByRole("button", { name: "我已理解并继续" }).click();
    const failure = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent/turn" && response.request().method() === "POST");
    await page.getByRole("button", { name: "生成目标复盘" }).click();
    expect(await (await failure).json()).toMatchObject({ ok: false, error: { code: "MODEL_CONFIG_MISSING" } });
    await page.reload();
    await expect(page.getByRole("heading", { name: "核对当前执行记录" })).toBeVisible();
    await selectHarnessProvider(page, "mock");
    await page.reload();
    await expect(page.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
    await page.getByRole("button", { name: "我已理解并继续" }).click();
    await page.getByRole("button", { name: "生成目标复盘" }).click();
    await expect(page.getByRole("heading", { name: "已保存的生成复盘" })).toBeVisible();
    await page.getByRole("checkbox", { name: /确认已核对当前执行数据/ }).check();
    await page.getByRole("button", { name: /确认完成目标（目标 \d+）/ }).click();
    await expect.poll(async () => page.evaluate(async () => (await (await fetch(`/api${location.pathname}`, { cache: "no-store" })).json()).data.goal.status)).toBe("completed");
    await page.reload();
    await expect(page.getByRole("heading", { name: "已保存的生成复盘" })).toBeVisible();
  } finally {
    await selectHarnessProvider(page, "mock");
  }
});
