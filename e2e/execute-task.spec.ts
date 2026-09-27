import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const goalText = "四周内学会 TypeScript，每天一小时，做一个待办网页";
const doneText = "待办网页可以新增、勾选完成和删除任务，刷新后仍保留记录。";
const firstTaskTitle = "练习 TypeScript 基础类型";

async function acceptPrivacyIfNeeded(page: Page) {
  const button = page.getByRole("button", { name: "我已理解并继续" });
  await expect(button.or(page.getByRole("radio", { name: "学习目标" }))).toBeVisible();
  if (await button.isVisible()) await button.click();
}

async function setProvider(page: Page, provider: "mock" | "qwen") {
  const result = await page.evaluate(async nextProvider => {
    const currentResponse = await fetch("/api/settings", { cache: "no-store" });
    const current = await currentResponse.json() as { ok: boolean; data?: { version: number } };
    if (!currentResponse.ok || !current.ok || !current.data) return { status: currentResponse.status, ok: false };
    const updateResponse = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: current.data.version, provider: nextProvider }),
    });
    const updated = await updateResponse.json() as { ok: boolean };
    return { status: updateResponse.status, ok: updated.ok };
  }, provider);
  expect(result).toEqual({ status: 200, ok: true });
}

async function readFormalPlan(page: Page) {
  const result = await page.evaluate(async () => {
    const goalId = location.pathname.split("/").at(-1);
    const response = await fetch(`/api/goals/${goalId}`, { cache: "no-store" });
    const payload = await response.json() as {
      ok: boolean;
      data?: { goal: { id: string; status: string }; currentPlan: { id: string; number: number; status: string } | null };
    };
    if (!response.ok || !payload.ok || !payload.data?.currentPlan) return null;
    return { goalId: payload.data.goal.id, goalStatus: payload.data.goal.status, ...payload.data.currentPlan };
  });
  expect(result).not.toBeNull();
  return result!;
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectUsableTaskTargets(scope: Locator) {
  const undersized = await scope.locator("button, input, textarea, select").evaluateAll(elements => elements.flatMap(element => {
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const rendered = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    if (!rendered || (rect.width >= 44 && rect.height >= 44)) return [];
    return [{ label: target.getAttribute("aria-label") ?? target.textContent?.trim() ?? target.tagName, width: rect.width, height: rect.height }];
  }));
  expect(undersized).toEqual([]);
}

async function createActiveGoal(page: Page) {
  await page.goto("/goals/new");
  await acceptPrivacyIfNeeded(page);
  await page.getByRole("radio", { name: "学习目标" }).check();
  await page.getByLabel("告诉教练你的目标").fill(goalText);
  await page.getByRole("button", { name: "创建并开始澄清" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/为了形成可核对的完成标准/)).toBeVisible();
  await page.getByLabel("告诉教练你的目标").fill(doneText);
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: /批准目标契约（草案 \d+ \/ 目标 \d+）/ }).click();
  await expect(page.getByRole("region", { name: "计划草案" })).toBeVisible();
  await page.getByRole("button", { name: /批准计划（草案 \d+ \/ 目标 \d+）/ }).click();
  await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
}

test("executes, records evidence, undoes, and manually revises a plan without model calls", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  let mutationRequests = 0;
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("request", request => {
    if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/")) mutationRequests += 1;
  });

  await createActiveGoal(page);
  const initialPlan = await readFormalPlan(page);
  expect(initialPlan).toMatchObject({ goalStatus: "active", number: 1, status: "approved" });
  const taskBoard = page.getByRole("region", { name: "任务" });
  await expect(taskBoard.locator(".task-board__item")).toHaveCount(3);
  await expect(page.locator(".current-action-card")).toContainText("按30分钟起步窗口推荐");

  await page.screenshot({ path: testInfo.outputPath("execution-workspace-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await expectUsableTaskTargets(page.locator(".current-action-card, .task-board, .undo-banner, .task-dialog, .task-editor"));
  await page.screenshot({ path: testInfo.outputPath("execution-workspace-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  let providerSwitchAttempted = false;
  let unexpectedAgentPosts = 0;
  await page.route("**/api/agent/turn", async route => {
    if (route.request().method() === "POST") unexpectedAgentPosts += 1;
    await route.abort("blockedbyclient");
  });
  try {
    providerSwitchAttempted = true;
    await setProvider(page, "qwen");
    await page.reload();
    await expect(page.getByRole("heading", { name: "先确认你的数据如何使用" })).toBeVisible();
    await page.getByRole("button", { name: "我已理解并继续" }).click();
    await expect(taskBoard.locator(".task-board__item")).toHaveCount(3);

    await page.getByRole("button", { name: "暂停目标" }).click();
    await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "恢复目标" })).toBeVisible();
    await page.getByRole("button", { name: "恢复目标" }).click();
    await expect(page.getByText("进行中", { exact: true }).first()).toBeVisible();

    let firstTask = taskBoard.locator(".task-board__item").filter({ hasText: firstTaskTitle });
    await firstTask.getByRole("button", { name: `开始：${firstTaskTitle}` }).click();
    await expect(firstTask.getByText("进行中", { exact: true })).toBeVisible();
    await firstTask.getByRole("spinbutton", { name: "实际用时（分钟）" }).fill("25");
    await firstTask.getByRole("spinbutton", { name: "实际用时（分钟）" }).press("Tab");
    firstTask = taskBoard.locator(".task-board__item").filter({ hasText: firstTaskTitle });
    await expect(firstTask.getByText("25 分钟", { exact: true })).toBeVisible();

    await firstTask.getByRole("button", { name: `完成：${firstTaskTitle}` }).click();
    const evidenceDialog = page.getByRole("dialog", { name: `完成任务：${firstTaskTitle}` });
    await evidenceDialog.getByLabel("文字说明").fill("基础类型练习已通过本地类型检查。");
    await evidenceDialog.getByRole("button", { name: "确认完成并保存证据" }).click();
    await expect(page.locator(".progress-panel")).toContainText("33%");
    await page.getByRole("button", { name: "撤销上一次修改" }).click();
    await expect(page.locator(".progress-panel")).toContainText("0%");
    firstTask = taskBoard.locator(".task-board__item").filter({ hasText: firstTaskTitle });
    await expect(firstTask.getByText("历史证据（不表示当前已完成）")).toBeVisible();
    await expect(firstTask.getByText("基础类型练习已通过本地类型检查。", { exact: true })).toBeVisible();
    await expect(firstTask.getByText("进行中", { exact: true })).toBeVisible();
    const mutationsBeforeUndoReload = mutationRequests;
    await page.reload();
    await expect(taskBoard.locator(".task-board__item")).toHaveCount(3);
    await expect(page.locator(".progress-panel")).toContainText("0%");
    firstTask = taskBoard.locator(".task-board__item").filter({ hasText: firstTaskTitle });
    await expect(firstTask.getByText("历史证据（不表示当前已完成）")).toBeVisible();
    await expect(firstTask.getByText("进行中", { exact: true })).toBeVisible();
    expect(mutationRequests).toBe(mutationsBeforeUndoReload);

    await taskBoard.getByRole("button", { name: "编辑计划任务" }).click();
    const editor = page.getByRole("dialog", { name: "编辑计划任务" });
    await editor.getByLabel(`行动：${firstTaskTitle}`).fill("创建 TypeScript 文件，并解释 Todo 接口中的每个字段。");
    await editor.getByRole("button", { name: "添加任务" }).click();
    const added = editor.locator(":scope > ol > li").last();
    await added.getByLabel("标题：新任务 4").fill("检查任务可维护性");
    await added.getByLabel("行动：检查任务可维护性").fill("检查待办代码的命名与模块边界。");
    await added.getByLabel("完成标准：检查任务可维护性").fill("记录一条已完成的可维护性改进。");
    await editor.getByLabel("修改原因").fill("补充维护性检查并明确第一项行动");

    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalOverflow(page);
    await expectUsableTaskTargets(editor);
    await page.screenshot({ path: testInfo.outputPath("manual-plan-editor-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await editor.getByRole("button", { name: "生成计划草案并审阅" }).click();

    const review = page.getByRole("region", { name: "计划草案" });
    await expect(review.locator(".plan-task-card")).toHaveCount(4);
    await expect(review.getByRole("heading", { name: "检查任务可维护性", exact: true })).toBeVisible();
    await review.getByRole("button", { name: /批准新计划（草案 \d+ \/ 目标 \d+）/ }).click();
    await expect(taskBoard.locator(".task-board__item")).toHaveCount(4);
    await expect(taskBoard.getByRole("heading", { name: "检查任务可维护性" })).toBeVisible();
    const successorPlan = await readFormalPlan(page);
    expect(successorPlan).toMatchObject({ goalId: initialPlan.goalId, goalStatus: "active", number: initialPlan.number + 1, status: "approved" });
    expect(successorPlan.id).not.toBe(initialPlan.id);
    const mutationsBeforeFinalReload = mutationRequests;
    await page.reload();
    await expect(taskBoard.locator(".task-board__item")).toHaveCount(4);
    await expect(taskBoard.getByRole("heading", { name: "检查任务可维护性" })).toBeVisible();
    expect(await readFormalPlan(page)).toEqual(successorPlan);
    expect(mutationRequests).toBe(mutationsBeforeFinalReload);
    expect(unexpectedAgentPosts).toBe(0);
  } finally {
    if (providerSwitchAttempted) await setProvider(page, "mock");
  }

  expect(browserErrors).toEqual([]);
});
