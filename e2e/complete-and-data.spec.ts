import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

test.describe.configure({ mode: "serial" });

const goalText = "四周内学会 TypeScript，每天一小时，做一个待办网页";
const doneText = "待办网页可以新增、勾选完成和删除任务，刷新后仍保留记录。";
const clearPhrase = "清除我的全部本地数据";

function validatedHarnessDatabasePath() {
  const configured = process.env.GOAL_COACH_E2E_DATABASE_PATH;
  if (!configured) throw new Error("GOAL_COACH_E2E_DATABASE_PATH is required for destructive lifecycle tests");
  const databasePath = resolve(configured);
  const runDirectory = dirname(databasePath);
  if (
    basename(databasePath) !== "goal-coach.db"
    || dirname(runDirectory) !== resolve(tmpdir())
    || !/^goal-coach-e2e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(basename(runDirectory))
  ) throw new Error(`Refusing non-harness database path: ${databasePath}`);
  return databasePath;
}

async function clearHarnessData(page: Page) {
  const result = await page.evaluate(async confirmationPhrase => {
    const settingsResponse = await fetch("/api/settings", { cache: "no-store" });
    const settings = await settingsResponse.json() as { ok: boolean; data?: { id: string } };
    if (!settingsResponse.ok || !settings.ok || !settings.data) return { status: settingsResponse.status, ok: false };
    const response = await fetch("/api/data/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationPhrase, expectedSettingId: settings.data.id, operationId: crypto.randomUUID() }),
    });
    const payload = await response.json() as { ok: boolean };
    return { status: response.status, ok: payload.ok };
  }, clearPhrase);
  expect(result).toEqual({ status: 200, ok: true });
}

async function acceptPrivacy(page: Page) {
  const button = page.getByRole("button", { name: "我已理解并继续" });
  await expect(button).toBeVisible();
  await button.click();
}

async function createActiveGoal(page: Page) {
  await page.goto("/goals/new");
  await acceptPrivacy(page);
  await page.getByRole("radio", { name: "学习目标" }).check();
  await page.getByLabel("告诉教练你的目标").fill(goalText);
  await page.getByRole("button", { name: "创建并开始澄清" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}$/);
  await page.getByLabel("告诉教练你的目标").fill(doneText);
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: /批准目标契约（草案 \d+ \/ 目标 \d+）/ }).click();
  await page.getByRole("button", { name: /批准计划（草案 \d+ \/ 目标 \d+）/ }).click();
  await expect(page.getByRole("region", { name: "任务" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectUsableTargets(page: Page, selector: string) {
  const undersized = await page.locator(selector).locator("button, input, textarea, select, a[href]").evaluateAll(elements => elements.flatMap(element => {
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const rendered = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    if (!rendered || (rect.width >= 44 && rect.height >= 44)) return [];
    return [{ label: target.getAttribute("aria-label") ?? target.textContent?.trim() ?? target.tagName, width: rect.width, height: rect.height }];
  }));
  expect(undersized).toEqual([]);
}

function readClearedRowCounts(databasePath: string) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const emptyTables = [
      "goals", "plan_versions", "tasks", "draft_artifacts", "check_ins", "task_evidence", "agent_runs",
      "approval_grants", "undo_records", "conversation_messages", "conversation_summaries", "user_preferences", "audit_events",
    ] as const;
    const counts = Object.fromEntries([...emptyTables, "operations", "app_settings"].map(table => [
      table,
      (database.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count,
    ]));
    const retainedOperation = database.prepare("select goal_id as goalId, tool_name as toolName, status, result from operations").get() as {
      goalId: string | null; toolName: string; status: string; result: string;
    };
    const setting = database.prepare("select privacy_accepted_at as privacyAcceptedAt from app_settings").get() as { privacyAcceptedAt: number | null };
    return { counts, retainedOperation, setting };
  } finally {
    database.close();
  }
}

test("completes with an explicit saved review, exports public data, resets preferences, and clears only the isolated harness database", async ({ page }, testInfo) => {
  const databasePath = validatedHarnessDatabasePath();
  const browserErrors: string[] = [];
  let agentPosts = 0;
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/agent/turn") agentPosts += 1;
  });
  await page.goto("/settings");
  await clearHarnessData(page);
  await createActiveGoal(page);

  const taskBoard = page.getByRole("region", { name: "任务" });
  for (let index = 0; index < 3; index += 1) {
    const task = taskBoard.locator(".task-board__item").nth(index);
    const title = (await task.getByRole("heading").textContent())!.trim();
    const actualMinutes = index === 0 ? "90" : "30";
    await task.getByRole("spinbutton", { name: "实际用时（分钟）" }).fill(actualMinutes);
    await task.getByRole("spinbutton", { name: "实际用时（分钟）" }).press("Tab");
    await expect(task.getByText(`${actualMinutes} 分钟`, { exact: true })).toBeVisible();
    await task.getByRole("button", { name: `完成：${title}` }).click();
    const dialog = page.getByRole("dialog", { name: `完成任务：${title}` });
    await dialog.getByLabel("文字说明").fill(`已核对：${title}`);
    await dialog.getByRole("button", { name: "确认完成并保存证据" }).click();
  }

  await expect(page.getByRole("heading", { name: "核对当前执行记录" })).toBeVisible();
  await expect(page.getByText("预计 180 分钟；已记录实际 150 分钟")).toBeVisible();
  await expect(page.getByText("请先显式生成并保存目标复盘；页面加载和刷新不会自动请求教练。")).toBeVisible();
  await page.getByRole("button", { name: "生成目标复盘" }).click();
  await expect(page.getByRole("heading", { name: "已保存的生成复盘" })).toBeVisible();
  const agentPostsAfterReflection = agentPosts;
  await page.reload();
  await expect(page.getByRole("heading", { name: "已保存的生成复盘" })).toBeVisible();
  expect(agentPosts).toBe(agentPostsAfterReflection);
  await expect(page.getByRole("button", { name: /确认完成目标（目标 \d+）/ })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("goal-review-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await expectUsableTargets(page, ".goal-review");
  await expect(page.getByRole("checkbox", { name: /确认已核对当前执行数据/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("goal-review-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("checkbox", { name: /确认已核对当前执行数据/ }).check();
  await page.getByRole("button", { name: /确认完成目标（目标 \d+）/ }).click();
  await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(async () => {
    const response = await fetch(`/api${location.pathname}`, { cache: "no-store" });
    const payload = await response.json() as { ok: boolean; data?: { goal: { status: string; agentState: string } } };
    return payload.ok ? payload.data?.goal : null;
  })).toMatchObject({ status: "completed", agentState: "completed" });

  await page.goto("/settings");
  await expect(page.getByText(/估时偏差 \d+\.\d{2}×/)).toBeVisible();
  await page.getByLabel("偏好时间段").fill("周末上午");
  await page.getByLabel("有效策略（每行一条）").fill("先做最小步骤");
  const savePreference = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings/preferences" && response.request().method() === "PATCH");
  await page.getByRole("button", { name: /保存教练偏好（偏好 \d+）/ }).click();
  expect((await savePreference).ok()).toBe(true);
  await page.reload();
  await expect(page.getByLabel("偏好时间段")).toHaveValue("周末上午");
  await expect(page.getByLabel("有效策略（每行一条）")).toHaveValue("先做最小步骤");
  await page.screenshot({ path: testInfo.outputPath("settings-data-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await expectUsableTargets(page, ".settings-card, .settings-grid");
  await page.screenshot({ path: testInfo.outputPath("settings-data-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  const clearPreference = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings/preferences" && response.request().method() === "DELETE");
  await page.getByRole("button", { name: "清除教练偏好" }).click();
  expect((await clearPreference).ok()).toBe(true);
  await page.reload();
  await expect(page.getByText("估时偏差 1.00×")).toBeVisible();
  await expect(page.getByLabel("偏好时间段")).toHaveValue("");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^goal-coach-export-\d{4}-\d{2}-\d{2}\.json$/);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Export download path unavailable");
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as Record<string, unknown>;
  expect(Object.keys(exported).sort()).toEqual([
    "checkIns", "conversationMessages", "conversationSummaries", "evidence", "exportedAt", "goals", "planVersions", "preferences", "schemaVersion", "tasks",
  ]);
  expect(JSON.stringify(exported)).not.toMatch(/apiKey|approvalGrant|operationId|"operations"/i);
  expect(exported.goals).toEqual(expect.arrayContaining([expect.objectContaining({ title: goalText, status: "completed" })]));

  const confirmation = page.getByLabel("输入确认短语");
  await confirmation.fill("清除全部数据");
  await expect(page.getByRole("button", { name: "永久清除全部本地数据" })).toBeDisabled();
  const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "3000"}`;
  const currentSettingsResponse = await page.request.get("/api/settings", { headers: { Origin: origin } });
  expect(currentSettingsResponse.ok()).toBe(true);
  const currentSettings = await currentSettingsResponse.json() as { ok: boolean; data: { id: string } };
  expect(currentSettings.ok).toBe(true);
  const rejectedResponse = await page.request.post("/api/data/clear", {
    headers: { Origin: origin },
    data: { confirmationPhrase: "清除全部数据", expectedSettingId: currentSettings.data.id, operationId: randomUUID() },
  });
  const rejected = { status: rejectedResponse.status(), payload: await rejectedResponse.json() as { ok: boolean; error?: { code: string } } };
  expect(rejected).toMatchObject({ status: 403, payload: { ok: false, error: { code: "APPROVAL_REQUIRED" } } });

  let clearBody: { confirmationPhrase: string; expectedSettingId: string; operationId: string } | null = null;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/data/clear") {
      clearBody = request.postDataJSON() as typeof clearBody;
    }
  });
  await confirmation.fill(clearPhrase);
  await page.getByRole("button", { name: "永久清除全部本地数据" }).click();
  await expect(page.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
  await expect(page.getByText("目标：1")).toBeVisible();
  await expect(page.getByText(/本机每日模型用量记录也已重置/).first()).toBeVisible();
  expect(clearBody).not.toBeNull();

  const replay = await page.evaluate(async body => {
    const response = await fetch("/api/data/clear", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() as { ok: boolean; data?: unknown } };
  }, clearBody!);
  expect(replay.status).toBe(200);
  expect(replay.payload).toMatchObject({ ok: true, data: { deletedCounts: { goals: 1, tasks: 3, preferences: 1 } } });

  const databaseState = readClearedRowCounts(databasePath);
  for (const [table, count] of Object.entries(databaseState.counts)) {
    expect.soft(count, table).toBe(table === "operations" || table === "app_settings" ? 1 : 0);
  }
  expect(databaseState.setting.privacyAcceptedAt).toBeNull();
  expect(databaseState.retainedOperation).toMatchObject({ goalId: null, toolName: "clear_all_data", status: "succeeded" });
  expect(databaseState.retainedOperation.result).not.toContain(goalText);
  expect(browserErrors).toEqual([]);
});
