import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const goalText = "四周内学会 TypeScript，每天一小时，做一个待办网页";
const doneText = "待办网页可以新增、勾选完成和删除任务，刷新后仍保留记录。";
const firstTaskTitle = "练习 TypeScript 基础类型";
const secondTaskTitle = "实现待办列表交互";
const blockerMessage = "我卡住了，请帮我分析。";

async function acceptPrivacyIfNeeded(page: Page) {
  const button = page.getByRole("button", { name: "我已理解并继续" });
  await expect(button.or(page.getByRole("radio", { name: "学习目标" }))).toBeVisible();
  if (await button.isVisible()) await button.click();
}

async function createActiveGoal(page: Page) {
  await page.goto("/goals/new");
  await acceptPrivacyIfNeeded(page);
  await page.getByRole("radio", { name: "学习目标" }).check();
  await page.getByLabel("告诉教练你的目标").fill(goalText);
  await page.getByRole("button", { name: "创建并开始澄清" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}$/);
  await page.getByLabel("告诉教练你的目标").fill(doneText);
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: /批准目标契约（草案 \d+ \/ 目标 \d+）/ }).click();
  await expect(page.getByRole("region", { name: "计划草案" })).toBeVisible();
  await page.getByRole("button", { name: /批准计划（草案 \d+ \/ 目标 \d+）/ }).click();
  await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
}

async function readWorkspace(page: Page) {
  const result = await page.evaluate(async () => {
    const goalId = location.pathname.split("/").at(-1);
    const response = await fetch(`/api/goals/${goalId}`, { cache: "no-store" });
    const payload = await response.json();
    return { status: response.status, payload };
  });
  expect(result.status).toBe(200);
  expect(result.payload.ok).toBe(true);
  return result.payload.data as {
    goal: { id: string; version: number; status: string };
    currentPlan: { id: string; number: number; version: number; status: string; milestones: string[] };
    planHistory: Array<{ id: string; status: string }>;
    tasks: Array<{ id: string; title: string; action: string; estimateMinutes: number; status: string; version: number; dependencyIds: string[] }>;
    pendingDrafts: Array<{ id: string; kind: string; payload: { milestones: string[]; tasks: Array<{ id: string; title: string; action: string; doneCriteria: string; estimateMinutes: number; dependencyIds: string[] }> } }>;
    replanTriggers: Array<{ code: string; reason: string }>;
  };
}

async function skipFirstTask(page: Page) {
  const result = await page.evaluate(async title => {
    const goalId = location.pathname.split("/").at(-1)!;
    const workspaceResponse = await fetch(`/api/goals/${goalId}`, { cache: "no-store" });
    const workspaceEnvelope = await workspaceResponse.json();
    const workspace = workspaceEnvelope.data;
    const task = workspace.tasks.find((candidate: { title: string }) => candidate.title === title);
    const response = await fetch(`/api/goals/${goalId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: task.version,
        expectedGoalVersion: workspace.goal.version,
        expectedPlanVersion: { id: workspace.currentPlan.id, version: workspace.currentPlan.version },
        operationId: crypto.randomUUID(),
        source: "ui_explicit",
        status: "skipped",
      }),
    });
    return { status: response.status, payload: await response.json() };
  }, firstTaskTitle);
  expect(result.status).toBe(200);
  expect(result.payload.ok).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectUsableTargets(scope: Locator) {
  const undersized = await scope.locator("button, input:not([type='radio']), textarea, select").evaluateAll(elements => elements.flatMap(element => {
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const rendered = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    if (!rendered || (rect.width >= 44 && rect.height >= 44)) return [];
    return [{ label: target.getAttribute("aria-label") ?? target.textContent?.trim() ?? target.tagName, width: rect.width, height: rect.height }];
  }));
  expect(undersized).toEqual([]);
}

async function expectUsableBlockerCategoryTargets(dialog: Locator) {
  const targets = dialog.locator(".blocker-dialog__options label");
  await expect(targets).toHaveCount(6);
  const rects = await targets.evaluateAll(elements => elements.map((element, index) => {
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    return {
      index,
      visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }));
  expect(rects.every(rect => rect.visible && rect.width >= 44 && rect.height >= 44)).toBe(true);
  const overlaps = rects.flatMap((first, firstIndex) => rects.slice(firstIndex + 1).flatMap(second => (
    first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top
      ? [[first.index, second.index]]
      : []
  )));
  expect(overlaps).toEqual([]);
}

test("diagnoses a blocker, reviews a revised plan, rejects once, then explicitly approves", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  const agentMessages: string[] = [];
  let mutationRequests = 0;
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.startsWith("/api/")) mutationRequests += 1;
    if (request.method() === "POST" && path === "/api/agent/turn") {
      const body = request.postDataJSON() as { message?: string };
      if (body.message) agentMessages.push(body.message);
    }
  });

  await createActiveGoal(page);
  const initial = await readWorkspace(page);
  const initialAgentCount = agentMessages.length;
  const originalMilestones = [...initial.currentPlan.milestones];
  const originalPlanId = initial.currentPlan.id;
  const originalSecond = initial.tasks.find(task => task.title === secondTaskTitle)!;

  await skipFirstTask(page);
  await skipFirstTask(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "计划可能需要调整" })).toBeVisible();
  await expect(page.getByText("同一任务已多次跳过。")).toBeVisible();
  const triggered = await readWorkspace(page);
  expect(triggered.replanTriggers).toContainEqual(expect.objectContaining({ code: "repeated_skip" }));
  expect(agentMessages.slice(initialAgentCount)).toEqual([]);

  await page.getByRole("button", { name: "报告阻碍" }).click();
  const blockerDialog = page.getByRole("dialog", { name: "哪里卡住了？" });
  await expect(blockerDialog).toContainText(`这次记录关联任务：${firstTaskTitle}`);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await expectUsableTargets(blockerDialog);
  await expectUsableBlockerCategoryTargets(blockerDialog);
  await page.screenshot({ path: testInfo.outputPath("blocker-dialog-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await blockerDialog.getByText("时间不足", { exact: true }).click();
  await expect(blockerDialog.getByRole("radio", { name: "时间不足" })).toBeChecked();
  await blockerDialog.getByLabel("补充说明（选填）").fill("今晚只有二十分钟");
  await blockerDialog.getByRole("button", { name: "请教练帮我分析" }).click();
  await expect(page.getByRole("heading", { name: "最小下一步" })).toBeVisible();
  await expect(page.getByText("先用 5 分钟打开当前任务，写下一个尚未解决的小问题。")).toBeVisible();
  expect(agentMessages.slice(initialAgentCount)).toEqual([blockerMessage]);

  await page.getByRole("button", { name: "请教练评估" }).click();
  let review = page.getByRole("region", { name: "比较两版计划" });
  await expect(review).toBeVisible();
  expect(agentMessages.slice(initialAgentCount)).toEqual([
    "我卡住了，请帮我分析。",
    "请根据最新反馈调整计划。",
  ]);

  let proposed = await readWorkspace(page);
  const firstDraft = proposed.pendingDrafts.find(draft => draft.kind === "replan")!;
  const adjusted = firstDraft.payload.tasks.find(task => task.title === secondTaskTitle)!;
  const added = firstDraft.payload.tasks.filter(task => !proposed.tasks.some(old => old.id === task.id));
  expect(added).toHaveLength(1);
  const starter = added[0];
  expect(starter.estimateMinutes).toBe(20);
  expect(starter.action.trim()).not.toBe("");
  expect(starter.doneCriteria.trim()).not.toBe("");
  expect(starter.dependencyIds).toEqual(originalSecond.dependencyIds);
  expect(adjusted.dependencyIds).toContain(starter.id);
  expect(adjusted.action).toContain(originalSecond.action);
  expect(adjusted.estimateMinutes + starter.estimateMinutes).toBe(originalSecond.estimateMinutes);
  expect(firstDraft.payload.tasks.reduce((sum, task) => sum + task.estimateMinutes, 0))
    .toBe(proposed.tasks.reduce((sum, task) => sum + task.estimateMinutes, 0));
  expect(firstDraft.payload.milestones).toEqual(originalMilestones);
  expect(proposed.currentPlan.id).toBe(originalPlanId);
  const formalBeforeRejection = {
    goalStatus: proposed.goal.status,
    planId: proposed.currentPlan.id,
    milestones: proposed.currentPlan.milestones,
    tasks: proposed.tasks.map(task => ({
      id: task.id,
      status: task.status,
      action: task.action,
      estimateMinutes: task.estimateMinutes,
    })),
  };

  await review.getByRole("button", { name: /要求修改（草案 \d+ \/ 目标 \d+）/ }).click();
  await expect.poll(async () => {
    const current = await readWorkspace(page);
    const draft = current.pendingDrafts.find(candidate => candidate.kind === "replan");
    return Boolean(draft && draft.id !== firstDraft.id);
  }).toBe(true);
  review = page.getByRole("region", { name: "比较两版计划" });
  await expect(review).toBeVisible();
  await expect(review.getByRole("button", { name: /批准新计划（草案 \d+ \/ 目标 \d+）/ })).toBeEnabled();
  expect(agentMessages.slice(initialAgentCount)).toEqual([
    "我卡住了，请帮我分析。",
    "请根据最新反馈调整计划。",
    "请重新提出调整方案。",
  ]);
  proposed = await readWorkspace(page);
  expect({
    goalStatus: proposed.goal.status,
    planId: proposed.currentPlan.id,
    milestones: proposed.currentPlan.milestones,
    tasks: proposed.tasks.map(task => ({
      id: task.id,
      status: task.status,
      action: task.action,
      estimateMinutes: task.estimateMinutes,
    })),
  }).toEqual(formalBeforeRejection);

  await page.screenshot({ path: testInfo.outputPath("replan-review-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await expectUsableTargets(page.locator(".adaptation-panel, .advice-card, .replan-review, .blocker-dialog"));
  await page.screenshot({ path: testInfo.outputPath("replan-review-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await review.getByRole("button", { name: /批准新计划（草案 \d+ \/ 目标 \d+）/ }).click();
  await expect(page.getByRole("region", { name: "比较两版计划" })).not.toBeVisible();
  const approved = await readWorkspace(page);
  expect(approved.goal.status).toBe("active");
  expect(approved.currentPlan.id).not.toBe(originalPlanId);
  expect(approved.currentPlan.number).toBe(initial.currentPlan.number + 1);
  expect(approved.currentPlan.milestones).toEqual(originalMilestones);
  expect(approved.planHistory).toContainEqual(expect.objectContaining({ id: originalPlanId, status: "superseded" }));
  const savedAdjusted = approved.tasks.find(task => task.title === secondTaskTitle)!;
  expect(savedAdjusted.action).toBe(adjusted.action);
  expect(savedAdjusted.estimateMinutes).toBe(adjusted.estimateMinutes);

  const mutationsBeforeReload = mutationRequests;
  const messagesBeforeReload = [...agentMessages];
  await page.reload();
  await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
  expect((await readWorkspace(page)).currentPlan.id).toBe(approved.currentPlan.id);
  expect(mutationRequests).toBe(mutationsBeforeReload);
  expect(agentMessages).toEqual(messagesBeforeReload);
  expect(browserErrors).toEqual([]);
});
