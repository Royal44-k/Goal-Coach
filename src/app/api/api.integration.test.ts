import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { POST as POST_AGENT } from "./agent/turn/route";
import * as Goals from "./goals/route";
import * as Goal from "./goals/[goalId]/route";
import * as Approvals from "./approvals/route";
import * as Tasks from "./goals/[goalId]/tasks/[taskId]/route";
import * as PlanDrafts from "./goals/[goalId]/plan-drafts/route";
import * as Reject from "./goals/[goalId]/plan-drafts/[draftId]/reject/route";
import * as ContractDrafts from "./goals/[goalId]/contract-drafts/route";
import * as CheckIns from "./goals/[goalId]/check-ins/route";
import * as Undo from "./goals/[goalId]/undo/route";
import * as Settings from "./settings/route";
import * as Preferences from "./settings/preferences/route";
import * as Export from "./export/route";
import * as Clear from "./data/clear/route";
import { createDatabase } from "@/server/db/client";
import { migrateDatabase } from "@/server/db/migrate";
import { createRepositories } from "@/server/repositories/repository-factory";
import { createServiceContainer } from "@/server/services/service-container";
import { loadServerEnv } from "@/server/config/env";
import { LOCAL_OWNER_ID } from "@/server/security/local-owner";
import { LOCAL_TYPESCRIPT_INPUT, LOCAL_TYPESCRIPT_DONE } from "@/server/agent/local-mock-model-client";
import { TaskCreateInputSchema } from "@/server/repositories/revision-contracts";
import { MockModelClient } from "@/server/agent/mock-model-client";
import { AppError } from "@/core/errors/app-error";
import { toSafeAgentTurnErrorResponse } from "./_shared/api-response";
import { AgentTurnError } from "@/server/agent/agent-turn-error";
vi.mock("@/server/services/service-container", async original => ({ ...await original<typeof import("@/server/services/service-container")>(), getServiceContainer: () => services }));
let db: ReturnType<typeof createDatabase>;
let repositories: ReturnType<typeof createRepositories>;
let services: ReturnType<typeof createServiceContainer>;
beforeEach(() => {
  db = createDatabase(":memory:"); migrateDatabase(db); repositories = createRepositories(db);
  services = createServiceContainer({ repositories, env: loadServerEnv({}) });
});
afterEach(() => db.$client.close());
const owner = LOCAL_OWNER_ID;
function request(method = "GET", body?: unknown, origin: string | null = "http://127.0.0.1:3000") { return new Request("http://127.0.0.1:3000/api/test", { method, headers: { ...(origin ? { origin } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
const ctx = (goalId: string) => ({ params: Promise.resolve({ goalId }) });
async function approved() {
  const created = await (await Goals.POST(request("POST", { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT }))).json();
  const goalId = created.data.goal.id as string;
  for (const message of [LOCAL_TYPESCRIPT_INPUT, LOCAL_TYPESCRIPT_DONE, "生成计划"]) {
    const response = await POST_AGENT(request("POST", { goalId, message, requestOperationId: randomUUID() }));
    expect(response.status).toBe(200);
    const result = await response.json();
    if (result.data.draftId) {
      const w = await services.goals.getWorkspace(owner, goalId);
      const draft = w.pendingDrafts.find(d => d.id === result.data.draftId)!;
      expect((await Approvals.POST(request("POST", { goalId, draftId: draft.id, expectedDraftVersion: draft.version, toolName: draft.kind === "goal_contract" ? "save_approved_contract" : "save_approved_plan", operationId: randomUUID() }))).status).toBe(200);
    }
  }
  return services.goals.getWorkspace(owner, goalId);
}

it("rejects invalid agent input through the fixed safe envelope before opening runtime data", async () => {
  const response = await POST_AGENT(new Request("http://127.0.0.1:3000/api/agent/turn", {
    method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
    body: JSON.stringify({ goalId: "not-a-uuid", message: "x" }),
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: { code: "VALIDATION_ERROR", message: "输入信息有误，请检查后重试。" } });
});
it.each([null, "https://evil.invalid", "http://localhost:3000"])("rejects mutation origin %s before malformed body processing", async origin => {
  const bad = new Request("http://127.0.0.1:3000/api/goals", { method: "POST", headers: origin ? { origin } : {}, body: "not-json" });
  const response = await Goals.POST(bad);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ ok: false, error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任。" } });
  expect(await services.goals.list(owner)).toEqual([]);
});
it("serves list/create/workspace, refuses ownership/scenario injection and returns uncached data", async () => {
  const w = await approved();
  const list = await Goals.GET(request()); expect(list.headers.get("cache-control")).toBe("no-store");
  expect(await list.json()).toMatchObject({ ok: true, data: [{ id: w.goal.id, progress: { total: 3 } }] });
  expect((await (await Goal.GET(request(), ctx(w.goal.id))).json()).data.currentPlan.milestones).toHaveLength(3);
  for (const extra of [{ ownerId: owner }, { scenario: "typescript" }, { agentState: "active" }])
    expect((await Goals.POST(request("POST", { category: "learning", initialMessage: "目标", ...extra }))).status).toBe(400);
  expect((await POST_AGENT(request("POST", { goalId: w.goal.id, message: "继续", requestOperationId: randomUUID(), scenario: "a" }))).status).toBe(400);
});
it("updates task execution idempotently, undoes it, creates and rejects an offline draft", async () => {
  let w = await approved();
  const taskId = w.tasks[0].id, goalId = w.goal.id;
  const target = { params: Promise.resolve({ goalId, taskId }) };
  const body = { expectedVersion: w.tasks[0].version, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, source: "ui_explicit", status: "doing", operationId: randomUUID() };
  const result = await (await Tasks.PATCH(request("PATCH", body), target)).json(); expect(result).toMatchObject({ ok: true, data: { status: "doing" } });
  expect(await (await Tasks.PATCH(request("PATCH", body), target)).json()).toEqual(result);
  expect((await Undo.POST(request("POST", { operationId: randomUUID() }), ctx(goalId))).status).toBe(200);
  w = await services.goals.getWorkspace(owner, goalId);
  expect((await CheckIns.POST(request("POST", { taskId: null, kind: "availability_change", note: "", blockerCategory: null, minutesSpent: null, availableWeeklyMinutes: 120, expectedGoalVersion: w.goal.version, operationId: randomUUID() }), ctx(goalId))).status).toBe(200);
  w = await services.goals.getWorkspace(owner, goalId);
  const draft = await (await PlanDrafts.POST(request("POST", { expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, expectedGoalVersion: w.goal.version, changeReason: "线下调整", tasks: w.tasks.map((t, i) => ({ ...TaskCreateInputSchema.strip().parse(t), title: i === 0 ? "修改标题" : t.title })), operationId: randomUUID() }), ctx(goalId))).json();
  expect(draft.ok).toBe(true);
  w = await services.goals.getWorkspace(owner, goalId);
  expect((await Reject.POST(request("POST", { expectedDraftVersion: draft.data.version, expectedGoalVersion: w.goal.version, operationId: randomUUID() }), { params: Promise.resolve({ goalId, draftId: draft.data.id }) })).status).toBe(200);
});
it("saves contract edits through the existing route without approving them", async () => {
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT });
  await services.agent.processTurn(owner, { goalId: goal.id, message: LOCAL_TYPESCRIPT_DONE, requestOperationId: randomUUID() });
  const w = await services.goals.getWorkspace(owner, goal.id), draft = w.pendingDrafts[0];
  if (draft.kind !== "goal_contract") throw new Error("fixture");
  const response = await ContractDrafts.POST(request("POST", { draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: w.goal.version, contract: { ...draft.payload.contract, weeklyMinutes: 90 }, operationId: randomUUID() }), ctx(goal.id));
  expect(response.status).toBe(200); expect((await services.goals.getWorkspace(owner, goal.id)).goal.weeklyMinutes).toBeNull();
});
it("bootstraps manual contracts on the same endpoint and rejects ambiguous or forged creation fields", async () => {
  const { goal } = await services.goals.create(owner, { category: "light_work", initialMessage: "整理资料" });
  const body = { expectedGoalVersion: goal.version, contract: { title: goal.title, category: goal.category, desiredOutcome: "资料分类", definitionOfDone: "完成三个目录", deadline: null, weeklyMinutes: null, constraints: null, motivation: null }, operationId: randomUUID() };
  for (const extra of [{ draftId: randomUUID() }, { expectedDraftVersion: 1 }, { assumptions: [] }, { source: "model" }, { ownerId: owner }])
    expect((await ContractDrafts.POST(request("POST", { ...body, ...extra }), ctx(goal.id))).status).toBe(400);
  const response = await ContractDrafts.POST(request("POST", body), ctx(goal.id));
  expect(response.status).toBe(200); expect((await response.json()).data.kind).toBe("goal_contract");
  expect((await services.goals.getWorkspace(owner, goal.id)).goal.desiredOutcome).toBeNull();
});
it("settings and preference routes never disclose private credentials and clear obeys generation", async () => {
  const first = await (await Settings.GET(request())).json();
  const setting = await (await Settings.PATCH(request("PATCH", { expectedVersion: first.data.version, privacyAccepted: true, privacyProvider: first.data.provider, privacyPolicyVersion: "2026-09-24", dailyInputTokenLimit: 500 }))).json();
  expect(setting).toMatchObject({ ok: true, data: { dailyInputTokenLimit: 500 } });
  expect(setting.data.apiKeyConfigured).toBe(false);
  for (const field of ["apiKey", "DASHSCOPE_API_KEY", "baseURL", "stack"]) expect(setting.data).not.toHaveProperty(field);
  const pref = await (await Preferences.GET(request())).json();
  expect((await Preferences.PATCH(request("PATCH", { expectedVersion: pref.data.version, preferredTimeWindow: "晚间", effectiveStrategies: ["小步"] }))).status).toBe(200);
  expect((await (await Preferences.DELETE(request("DELETE", {}))).json()).data.preferredTimeWindow).toBeNull();
  expect((await Export.GET(request())).status).toBe(200);
  expect((await Clear.POST(request("POST", { confirmationPhrase: "错误", expectedSettingId: setting.data.id, operationId: randomUUID() }))).status).toBe(403);
  expect((await Clear.POST(request("POST", { confirmationPhrase: "清除我的全部本地数据", expectedSettingId: setting.data.id, operationId: randomUUID() }))).status).toBe(200);
});
it("settings exposes only key presence on GET and PATCH and rejects derived or secret writes", async () => {
  const secret = "synthetic-api-test-key";
  const baseURL = "https://synthetic-provider.example.invalid/v1";
  services = createServiceContainer({ repositories, env: loadServerEnv({ DASHSCOPE_API_KEY: secret, DASHSCOPE_BASE_URL: baseURL }) });
  const first = await (await Settings.GET(request())).json();
  expect(first).toEqual({ ok: true, data: {
    id: expect.any(String), version: 1, createdAt: expect.any(String), updatedAt: expect.any(String),
    privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null, provider: "mock", model: "qwen3.7-flash-2026-07-15",
    fallbackEnabled: false, dailyInputTokenLimit: 100000, dailyOutputTokenLimit: 30000, apiKeyConfigured: true,
  } });
  for (const patch of [{ apiKeyConfigured: false }, { apiKey: secret }, { baseURL: "https://example.invalid" }, { DASHSCOPE_API_KEY: secret }]) {
    const response = await Settings.PATCH(request("PATCH", { expectedVersion: first.data.version, ...patch }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: { code: "VALIDATION_ERROR", message: "输入信息有误，请检查后重试。" } });
  }
  const updated = await (await Settings.PATCH(request("PATCH", { expectedVersion: first.data.version, provider: "qwen" }))).json();
  expect(updated).toEqual({ ok: true, data: { ...first.data, version: 2, updatedAt: expect.any(String), provider: "qwen" } });
  expect(JSON.stringify(updated)).not.toContain(secret);
  expect(JSON.stringify(updated)).not.toContain(baseURL);
  expect(await repositories.support.getSettingsByOwner(owner)).not.toHaveProperty("apiKeyConfigured");
});
it("preference API accepts exact bounds and rejects overflow or wrong types without writing", async () => {
  const first = await (await Preferences.GET(request())).json();
  const response = await Preferences.PATCH(request("PATCH", {
    expectedVersion: first.data.version, preferredTimeWindow: ` ${"窗".repeat(120)} `,
    effectiveStrategies: Array(10).fill(` ${"策".repeat(240)} `), estimateBias: 1.5,
  }));
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.data).toMatchObject({ preferredTimeWindow: "窗".repeat(120), effectiveStrategies: Array(10).fill("策".repeat(240)), estimateBias: 1.5 });
  for (const patch of [
    { preferredTimeWindow: "窗".repeat(121) }, { preferredTimeWindow: " " }, { preferredTimeWindow: 2 },
    { effectiveStrategies: Array(11).fill("策") }, { effectiveStrategies: ["策".repeat(241)] },
    { effectiveStrategies: [""] }, { effectiveStrategies: "策" }, { effectiveStrategies: [false] },
  ]) {
    const rejected = await Preferences.PATCH(request("PATCH", { expectedVersion: saved.data.version, ...patch }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ ok: false, error: { code: "VALIDATION_ERROR", message: "输入信息有误，请检查后重试。" } });
    expect(await (await Preferences.GET(request())).json()).toEqual(saved);
  }
  const clearedFields = await (await Preferences.PATCH(request("PATCH", { expectedVersion: saved.data.version, preferredTimeWindow: null, effectiveStrategies: [] }))).json();
  expect(clearedFields.data).toMatchObject({ preferredTimeWindow: null, effectiveStrategies: [] });
});
it("rejects deletes without UI confirmation and supports a displayed-version confirmed deletion", async () => {
  const w = await approved();
  expect((await Goal.DELETE(request("DELETE", { confirmationPhrase: w.goal.title, operationId: randomUUID() }), ctx(w.goal.id))).status).toBe(400);
  const task = w.tasks[2];
  expect((await Tasks.DELETE(request("DELETE", { source: "ui_confirmation", confirmationPhrase: task.title, expectedTaskVersion: task.version, expectedGoalVersion: w.goal.version, operationId: randomUUID() }), { params: Promise.resolve({ goalId: w.goal.id, taskId: task.id }) })).status).toBe(200);
});
it("agent failures preserve exact safe envelope, saved-change notice and first-error replay", async () => {
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT });
  const secret = randomUUID();
  const mock = new MockModelClient([
    { text: "", toolCalls: [{ id: randomUUID(), name: "create_goal_contract_draft", argumentsJson: JSON.stringify({ goalId: goal.id, expectedGoalVersion: goal.version, contract: { title: goal.title, category: goal.category, desiredOutcome: "网页", definitionOfDone: "完成", deadline: null, weeklyMinutes: null, constraints: null, motivation: null }, assumptions: [] }) }], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "tool_calls" },
  ]);
  let calls = 0;
  services = createServiceContainer({ repositories, env: loadServerEnv({}), mockClientFactory: () => ({ complete: request => { if (calls++ > 0) throw new AppError("MODEL_TIMEOUT", 504, secret, secret); return mock.complete(request); } }) });
  const body = { goalId: goal.id, message: "生成契约", requestOperationId: randomUUID() };
  const response = await POST_AGENT(request("POST", body)); expect(response.status).toBe(504);
  const first = await response.json();
  expect(first).toEqual({ ok: false, error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。 本次执行中已有更改保存成功，请先刷新查看当前状态。" } });
  expect(await (await POST_AGENT(request("POST", body))).json()).toEqual(first);
  expect(JSON.stringify(first)).not.toContain(secret);
  expect(toSafeAgentTurnErrorResponse(new AgentTurnError({ code: "MODEL_TIMEOUT", status: 504, state: "active", persistedChange: false }))).toEqual({ code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" });
  expect(toSafeAgentTurnErrorResponse(new AppError("MODEL_TIMEOUT", 504, secret, "任意详情"))).toEqual({ code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" });
});
