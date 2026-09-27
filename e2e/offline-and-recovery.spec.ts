import { expect, test, type Page, type Route } from "@playwright/test";
import { createActiveGoal, firstTaskTitle } from "./helpers/goal-fixtures";

test.describe.configure({ mode: "serial" });

type WorkspaceSnapshot = {
  goal: { id: string; version: number; status: string; agentState: string };
  currentPlan: { id: string; version: number; number: number; status: string } | null;
  tasks: Array<{ id: string; version: number; title: string; status: string }>;
  checkIns: Array<{ id: string; version: number; blockerCategory: string | null; note: string | null }>;
};

async function readWorkspace(page: Page): Promise<WorkspaceSnapshot> {
  const result = await page.evaluate(async () => {
    const goalId = location.pathname.split("/").at(-1);
    const response = await fetch(`/api/goals/${goalId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Workspace read failed with ${response.status}`);
    const payload = await response.json() as { ok: boolean; data?: WorkspaceSnapshot };
    if (!payload.ok || !payload.data) throw new Error("Workspace envelope was not successful");
    return payload.data;
  });
  return result;
}

function formalSnapshot(workspace: WorkspaceSnapshot) {
  return {
    goal: workspace.goal,
    currentPlan: workspace.currentPlan,
    tasks: workspace.tasks,
    checkIns: workspace.checkIns,
  };
}

test("shows manual mode after a 45-second HTTP timeout fixture without duplicating the saved blocker", async ({ page }, testInfo) => {
  testInfo.setTimeout(90_000);
  await createActiveGoal(page);
  const before = await readWorkspace(page);
  expect(before.checkIns).toHaveLength(0);

  const goalId = before.goal.id;
  let blockerPosts = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/goals/${goalId}/check-ins`) {
      blockerPosts += 1;
    }
  });

  let releaseDelay: () => void = () => undefined;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let firstRouteSettled: Promise<void> = Promise.resolve();
  let firstRouteStarted = false;
  let firstStartedAt = 0;
  let firstFinishedAt = 0;
  const agentBodies: Array<{ goalId: string; message: string; requestOperationId: string; explicitIntent: boolean }> = [];
  let attempts = 0;
  const agentRoute = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as (typeof agentBodies)[number];
    if (body.goalId !== goalId) {
      await route.continue();
      return;
    }
    agentBodies.push(body);
    attempts += 1;
    if (attempts === 1) {
      firstStartedAt = Date.now();
      firstRouteStarted = true;
      firstRouteSettled = (async () => {
        await new Promise<void>(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (delayTimer) clearTimeout(delayTimer);
            delayTimer = null;
            resolve();
          };
          releaseDelay = finish;
          delayTimer = setTimeout(finish, 45_000);
        });
        firstFinishedAt = Date.now();
        await route.fulfill({
          status: 504,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" },
          }),
        });
      })();
      await firstRouteSettled;
      return;
    }
    await route.continue();
  };
  await page.route("**/api/agent/turn", agentRoute);

  try {
    await page.getByRole("button", { name: "报告阻碍" }).click();
    const dialog = page.getByRole("dialog", { name: "哪里卡住了？" });
    await dialog.getByText("时间不足", { exact: true }).click();
    await dialog.getByLabel("补充说明（选填）").fill("今晚只有二十分钟");
    await dialog.getByRole("button", { name: "请教练帮我分析" }).click();

    await expect(page.getByRole("alert").filter({ hasText: /模型响应超时.*手动模式/u })).toBeVisible({ timeout: 60_000 });
    expect(firstFinishedAt - firstStartedAt).toBeGreaterThanOrEqual(45_000);
    expect(blockerPosts).toBe(1);

    const afterTimeout = await readWorkspace(page);
    expect(afterTimeout.currentPlan).toEqual(before.currentPlan);
    expect(afterTimeout.tasks).toEqual(before.tasks);
    expect(afterTimeout.checkIns).toEqual([
      expect.objectContaining({ blockerCategory: "insufficient_time", note: "今晚只有二十分钟" }),
    ]);
    await expect(page.getByRole("button", { name: "编辑计划任务" })).toBeEnabled();
    await expect(page.getByRole("button", { name: `开始：${firstTaskTitle}` })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("timeout-manual-mode-desktop.png"), fullPage: true });

    await page.getByRole("button", { name: "显式发起新一轮" }).click();
    await expect(page.getByRole("heading", { name: "最小下一步" })).toBeVisible();
    expect(agentBodies).toHaveLength(2);
    expect(agentBodies[0]).toMatchObject({ goalId, message: "我卡住了，请帮我分析。", explicitIntent: true });
    expect(agentBodies[1]).toMatchObject({ goalId, message: "我卡住了，请帮我分析。", explicitIntent: true });
    expect(agentBodies[1].requestOperationId).not.toBe(agentBodies[0].requestOperationId);
    expect(blockerPosts).toBe(1);

    const beforeReload = await readWorkspace(page);
    expect(beforeReload.checkIns).toEqual(afterTimeout.checkIns);
    let reloadMutations = 0;
    const countReloadMutations = (request: { method(): string; url(): string }) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/")) reloadMutations += 1;
    };
    page.on("request", countReloadMutations);
    await page.reload();
    await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
    page.off("request", countReloadMutations);
    expect(reloadMutations).toBe(0);
    expect(formalSnapshot(await readWorkspace(page))).toEqual(formalSnapshot(beforeReload));
  } finally {
    releaseDelay();
    if (firstRouteStarted) await firstRouteSettled.catch(() => undefined);
    await page.unroute("**/api/agent/turn", agentRoute);
  }
});

test("replays the exact task mutation after its committed response is lost", async ({ page }) => {
  await createActiveGoal(page);
  const before = await readWorkspace(page);
  const task = before.tasks.find(candidate => candidate.title === firstTaskTitle);
  if (!task) throw new Error("Expected finite fixture task");

  const pathname = `/api/goals/${before.goal.id}/tasks/${task.id}`;
  const rawBodies: string[] = [];
  const upstreamPayloads: unknown[] = [];
  let intercepted = 0;
  await page.route(`**${pathname}`, async route => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    intercepted += 1;
    rawBodies.push(route.request().postData() ?? "");
    const upstream = await route.fetch();
    upstreamPayloads.push(await upstream.json());
    if (intercepted === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ response: upstream });
  });

  await page.getByRole("button", { name: `开始：${firstTaskTitle}` }).click();
  await expect(page.getByRole("alert").filter({ hasText: "无法确认这次修改是否执行" })).toBeVisible();
  const replayResponsePromise = page.waitForResponse(response => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname === pathname
    && response.ok()
  ));
  const [replayResponse] = await Promise.all([
    replayResponsePromise,
    page.getByRole("button", { name: "查询本次修改结果" }).click(),
  ]);
  const replayPayload = await replayResponse.json();
  await expect(page.getByRole("alert").filter({ hasText: "无法确认这次修改是否执行" })).not.toBeVisible();
  const taskItem = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: firstTaskTitle }) });
  await expect(taskItem.getByText("进行中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `开始：${firstTaskTitle}` })).toBeEnabled();

  expect(intercepted).toBe(2);
  expect(rawBodies[1]).toBe(rawBodies[0]);
  expect(JSON.parse(rawBodies[1]).operationId).toBe(JSON.parse(rawBodies[0]).operationId);
  expect(upstreamPayloads[1]).toEqual(upstreamPayloads[0]);
  expect(replayPayload).toEqual(upstreamPayloads[1]);

  const after = await readWorkspace(page);
  const updated = after.tasks.find(candidate => candidate.id === task.id);
  expect(updated).toMatchObject({ status: "doing", version: task.version + 1 });
  expect(after.goal.version).toBe(before.goal.version + 1);
  expect(after.currentPlan).toEqual(before.currentPlan);
  const beforeReload = formalSnapshot(after);
  await page.reload();
  await expect(page.getByRole("heading", { name: "当前已批准计划" })).toBeVisible();
  expect(formalSnapshot(await readWorkspace(page))).toEqual(beforeReload);
});
