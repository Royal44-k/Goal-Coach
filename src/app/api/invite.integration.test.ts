import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@/server/db/client";
import { migrateDatabase } from "@/server/db/migrate";
import { createRepositories } from "@/server/repositories/repository-factory";
import { createServiceContainer } from "@/server/services/service-container";
import { loadServerEnv } from "@/server/config/env";
import { AuthService } from "@/server/auth/auth-service";
import type { AuthSession } from "@/server/auth/auth-contracts";
import * as Goals from "./goals/route";
import * as Goal from "./goals/[goalId]/route";
import * as Export from "./export/route";
import * as Clear from "./data/clear/route";
import * as Settings from "./settings/route";
import * as Agent from "./agent/turn/route";
import * as Tasks from "./goals/[goalId]/tasks/[taskId]/route";
import * as Approvals from "./approvals/route";
import * as Contracts from "./goals/[goalId]/contract-drafts/route";
import * as Plans from "./goals/[goalId]/plan-drafts/route";
import * as Reject from "./goals/[goalId]/plan-drafts/[draftId]/reject/route";
import * as CheckIns from "./goals/[goalId]/check-ins/route";
import * as Undo from "./goals/[goalId]/undo/route";
import * as Preferences from "./settings/preferences/route";
import * as Readiness from "./settings/model-readiness/route";
import { TaskCreateInputSchema } from "@/server/repositories/revision-contracts";
import { LOCAL_TYPESCRIPT_DONE, LOCAL_TYPESCRIPT_INPUT } from "@/server/agent/local-mock-model-client";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
vi.mock("@/server/services/service-container", async original => ({ ...await original<typeof import("@/server/services/service-container")>(), getServiceContainer: () => services }));
vi.mock("@/server/auth/auth-container", () => ({ getAuthService: () => auth }));
let db: ReturnType<typeof createDatabase>, services: ReturnType<typeof createServiceContainer>, auth: AuthService;
let alice: AuthSession, bob: AuthSession;
const origin = "https://coach.example.invalid";
export function request(method = "GET", body?: unknown, session?: AuthSession, source: string | null = origin) {
  return new Request(`${origin}/api/test`, { method, headers: { ...(source ? { origin: source } : {}), ...(session ? { cookie: `goal_coach_session=${session.token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const ctx = (goalId: string) => ({ params: Promise.resolve({ goalId }) });
beforeEach(async () => {
  vi.stubEnv("APP_MODE", "invite"); vi.stubEnv("APP_ORIGIN", origin);
  db = createDatabase(":memory:"); migrateDatabase(db);
  services = createServiceContainer({ repositories: createRepositories(db), env: loadServerEnv({}) });
  auth = new AuthService({ database: db });
  alice = await auth.register({ username: "alice", password: "Synthetic-password-a", inviteToken: auth.bootstrapAdminInvite().token });
  bob = await auth.register({ username: "bob", password: "Synthetic-password-b", inviteToken: auth.createInvite(alice.actor).token });
});
afterEach(() => { db.$client.close(); vi.unstubAllEnvs(); });
it("denies anonymous reads and malformed cookies before returning business data", async () => {
  for (const get of [Goals.GET, Export.GET, Settings.GET, Preferences.GET, Readiness.GET]) {
    expect((await get(request())).status).toBe(401);
    expect((await get(new Request(`${origin}/api/test`, { headers: { cookie: "goal_coach_session=%ZZ" } }))).status).toBe(401);
  }
});
it("rejects cross-account goal/task/draft/approval/check-in/undo mutations without changing A", async () => {
  const owner = alice.actor.ownerId;
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT });
  for (const message of [LOCAL_TYPESCRIPT_INPUT, LOCAL_TYPESCRIPT_DONE, "生成计划"]) {
    const result = await services.agent.processTurn(owner, { goalId: goal.id, message, requestOperationId: randomUUID() });
    if (result.draftId) {
      const draft = (await services.goals.getWorkspace(owner, goal.id)).pendingDrafts.find(d => d.id === result.draftId)!;
      await services.approvals.approve(owner, { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: draft.kind === "goal_contract" ? "save_approved_contract" : "save_approved_plan", operationId: randomUUID() });
    }
  }
  const w = await services.goals.getWorkspace(owner, goal.id), task = w.tasks[0];
  const own = (await services.goals.create(bob.actor.ownerId, { category: "learning", initialMessage: "Bob" })).goal;
  const expectedPlanVersion = { id: w.currentPlan!.id, version: w.currentPlan!.version };
  const planBody = { expectedPlanVersion, expectedGoalVersion: w.goal.version, changeReason: "调整", tasks: w.tasks.map((t, index) => ({ ...TaskCreateInputSchema.strip().parse(t), title: index === 0 ? "调整后的任务" : t.title })), operationId: randomUUID() };
  const draftResponse = await Plans.POST(request("POST", planBody, alice), ctx(goal.id)); expect(draftResponse.status).toBe(200);
  const draft = (await draftResponse.json()).data;
  const snapshot = await services.goals.getWorkspace(owner, goal.id);
  const taskBody = { expectedVersion: task.version, expectedGoalVersion: snapshot.goal.version, expectedPlanVersion, source: "ui_explicit", status: "doing", operationId: randomUUID() };
  const contract = { title: "目标", category: "learning", desiredOutcome: "结果", definitionOfDone: "完成", deadline: null, weeklyMinutes: null, constraints: null, motivation: null };
  const requests = [
    () => Goal.PATCH(request("PATCH", { status: "paused", expectedVersion: snapshot.goal.version, operationId: randomUUID() }, bob), ctx(goal.id)),
    () => Goal.DELETE(request("DELETE", { source: "ui_confirmation", confirmationPhrase: w.goal.title, expectedGoalVersion: snapshot.goal.version, operationId: randomUUID() }, bob), ctx(goal.id)),
    () => Contracts.POST(request("POST", { expectedGoalVersion: snapshot.goal.version, contract, operationId: randomUUID() }, bob), ctx(goal.id)),
    () => Contracts.POST(request("POST", { draftId: draft.id, expectedDraftVersion: draft.version, expectedGoalVersion: snapshot.goal.version, contract, operationId: randomUUID() }, bob), ctx(goal.id)),
    () => Plans.POST(request("POST", planBody, bob), ctx(goal.id)),
    () => Reject.POST(request("POST", { expectedDraftVersion: draft.version, expectedGoalVersion: snapshot.goal.version, operationId: randomUUID() }, bob), { params: Promise.resolve({ goalId: goal.id, draftId: draft.id }) }),
    () => Tasks.PATCH(request("PATCH", taskBody, bob), { params: Promise.resolve({ goalId: goal.id, taskId: task.id }) }),
    () => Tasks.PATCH(request("PATCH", taskBody, bob), { params: Promise.resolve({ goalId: own.id, taskId: task.id }) }),
    () => Tasks.DELETE(request("DELETE", { source: "ui_confirmation", confirmationPhrase: task.title, expectedTaskVersion: task.version, expectedGoalVersion: snapshot.goal.version, operationId: randomUUID() }, bob), { params: Promise.resolve({ goalId: goal.id, taskId: task.id }) }),
    () => CheckIns.POST(request("POST", { taskId: null, kind: "availability_change", note: "", blockerCategory: null, minutesSpent: null, availableWeeklyMinutes: 120, expectedGoalVersion: snapshot.goal.version, operationId: randomUUID() }, bob), ctx(goal.id)),
    () => Undo.POST(request("POST", { operationId: randomUUID() }, bob), ctx(goal.id)),
    () => Approvals.POST(request("POST", { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() }, bob)),
    () => Approvals.POST(request("POST", { goalId: own.id, draftId: draft.id, expectedDraftVersion: draft.version, toolName: "save_approved_plan", operationId: randomUUID() }, bob)),
  ];
  for (const send of requests) { const denied = await send(); expect([403, 404, 409]).toContain(denied.status); expect(await denied.json()).toMatchObject({ ok: false }); }
  expect(await services.goals.getWorkspace(owner, goal.id)).toEqual(snapshot);
});
it("keeps preference and consent rows independent and revokes disabled/reset sessions at HTTP boundary", async () => {
  const preference = await (await Preferences.GET(request("GET", undefined, bob))).json();
  expect((await Preferences.PATCH(request("PATCH", { expectedVersion: preference.data.version, preferredTimeWindow: "晚间" }, bob))).status).toBe(200);
  expect((await (await Preferences.GET(request("GET", undefined, alice))).json()).data.preferredTimeWindow).toBeNull();
  const setting = await services.settings.get(bob.actor.ownerId); await services.settings.update(bob.actor.ownerId, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: setting.provider, privacyPolicyVersion: "2026-09-24" });
  expect((await services.settings.get(alice.actor.ownerId)).privacyAcceptedAt).toBeNull();
  await auth.resetPassword("bob", "New-synthetic-password");
  expect((await Goals.GET(request("GET", undefined, bob))).status).toBe(401);
  bob = await auth.login({ username: "bob", password: "New-synthetic-password" }); auth.disableUser(alice.actor, bob.actor.ownerId);
  expect((await Export.GET(request("GET", undefined, bob))).status).toBe(401);
});
it("withdraws only the invited account's model consent and blocks its next turn", async () => {
  services = createServiceContainer({
    repositories: createRepositories(db),
    env: loadServerEnv({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic" }),
    modelClientDecorator: () => ({ async complete() { throw new Error("unexpected model dispatch"); } }),
  });
  const owner = bob.actor.ownerId;
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: "Synthetic goal" });
  const initial = await services.settings.get(owner);
  const accepted = await services.settings.update(owner, { expectedVersion: initial.version, privacyAccepted: true, privacyProvider: initial.provider, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
  const response = await Settings.PATCH(request("PATCH", { expectedVersion: accepted.version, privacyAccepted: false }, bob));
  expect(response.status).toBe(200);
  const withdrawn = (await response.json()).data;
  expect(withdrawn).toMatchObject({ id: accepted.id, provider: accepted.provider, version: accepted.version + 1, privacyAcceptedAt: null, dailyInputTokenLimit: accepted.dailyInputTokenLimit, dailyOutputTokenLimit: accepted.dailyOutputTokenLimit });
  expect((await services.settings.get(alice.actor.ownerId)).privacyAcceptedAt).toBeNull();
  expect((await services.goals.getWorkspace(owner, goal.id)).goal.id).toBe(goal.id);
  expect((await Settings.PATCH(request("PATCH", { expectedVersion: accepted.version, privacyAccepted: false }, bob))).status).toBe(409);
  const turn = await Agent.POST(request("POST", { goalId: goal.id, message: "继续", requestOperationId: randomUUID() }, bob));
  expect(turn.status).toBe(403);
  expect(db.$client.prepare("SELECT count(*) AS n FROM agent_runs WHERE owner_id = ?").get(owner)).toEqual({ n: 0 });
});
it("bounds a chunked auth request and does not accept credential query parameters", async () => {
  const Login = await import("./auth/login/route"); let pulls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  const streamed = new Request(`${origin}/api/auth/login`, { method: "POST", headers: { origin }, body: stream, duplex: "half" } as RequestInit);
  expect((await Login.POST(streamed)).status).toBe(413); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(7);
  const query = new Request(`${origin}/api/auth/login?password=not-a-real-secret`, { method: "POST", headers: { origin }, body: "{}" });
  expect((await Login.POST(query)).status).toBe(400);
});
it("derives separate owners from sessions and refuses injected ownership", async () => {
  const created = await (await Goals.POST(request("POST", { category: "learning", initialMessage: "Alice private goal" }, alice))).json();
  expect(created.ok).toBe(true);
  expect(created.data.goal.ownerId).toBe(alice.actor.ownerId);
  expect((await Goal.GET(request("GET", undefined, bob), ctx(created.data.goal.id))).status).toBe(404);
  expect((await (await Goals.GET(request("GET", undefined, bob))).json()).data).toEqual([]);
  expect((await Goals.POST(request("POST", { category: "learning", initialMessage: "forged", ownerId: alice.actor.ownerId }, bob))).status).toBe(400);
  expect(JSON.stringify(await (await Export.GET(request("GET", undefined, bob))).json())).not.toContain("Alice private goal");
});
it("allows a nonlocal owner mock tool loop, denies another owner's turn and replay", async () => {
  const { goal } = await services.goals.create(alice.actor.ownerId, { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT });
  await services.agent.processTurn(alice.actor.ownerId, { goalId: goal.id, message: LOCAL_TYPESCRIPT_INPUT, requestOperationId: randomUUID() });
  const body = { goalId: goal.id, message: LOCAL_TYPESCRIPT_DONE, requestOperationId: randomUUID() };
  expect((await Agent.POST(request("POST", body, alice))).status).toBe(200);
  expect((await services.goals.getWorkspace(alice.actor.ownerId, goal.id)).pendingDrafts).toHaveLength(1);
  expect((await Agent.POST(request("POST", body, bob))).status).toBe(404);
});
it("returns only actor metadata, sets secure cookies, logs out and gates administrators", async () => {
  const Login = await import("./auth/login/route"); const Session = await import("./auth/session/route");
  const Logout = await import("./auth/logout/route"); const Invites = await import("./admin/invites/route"); const Users = await import("./admin/users/route");
  const login = await Login.POST(request("POST", { username: "bob", password: "Synthetic-password-b" }));
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "SameSite=Lax", "Path=/", "Secure", "Expires="]) expect(cookie).toContain(flag);
  expect(await login.json()).toEqual({ ok: true, data: { actor: bob.actor } });
  expect((await (await Session.GET(request("GET", undefined, bob))).json()).data).toEqual({ mode: "invite", actor: bob.actor });
  expect((await Invites.GET(request("GET", undefined, bob))).status).toBe(403);
  expect((await Users.GET(request("GET", undefined, bob))).status).toBe(403);
  const invite = await (await Invites.POST(request("POST", {}, alice))).json();
  expect(invite.data.token).toHaveLength(43);
  expect(JSON.stringify(await (await Invites.GET(request("GET", undefined, alice))).json())).not.toContain(invite.data.token);
  const logout = await Logout.POST(request("POST", {}, bob));
  expect(logout.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
  expect((await Goals.GET(request("GET", undefined, bob))).status).toBe(401);
});
it("registers from a body invitation and rejects unknown input fields", async () => {
  const Register = await import("./auth/register/route");
  const token = auth.createInvite(alice.actor).token;
  expect((await Register.POST(request("POST", { username: "charlie", password: "Synthetic-password-c", inviteToken: token, ownerId: alice.actor.ownerId }))).status).toBe(400);
  const response = await Register.POST(request("POST", { username: "charlie", password: "Synthetic-password-c", inviteToken: token }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { actor: { username: "charlie", role: "member" } } });
  expect((await Register.POST(request("POST", { username: "delta", password: "Synthetic-password-d", inviteToken: token }))).status).toBe(400);
});
it("clears only the current account's business rows and retains both identities", async () => {
  await services.goals.create(alice.actor.ownerId, { category: "learning", initialMessage: "Alice retained" });
  await services.goals.create(bob.actor.ownerId, { category: "learning", initialMessage: "Bob removed" });
  const setting = await services.settings.get(bob.actor.ownerId);
  expect((await Clear.POST(request("POST", { confirmationPhrase: "清除我的全部本地数据", expectedSettingId: setting.id, operationId: randomUUID() }, bob))).status).toBe(200);
  expect(await services.goals.list(bob.actor.ownerId)).toHaveLength(0);
  expect(await services.goals.list(alice.actor.ownerId)).toHaveLength(1);
  expect(auth.authenticate(bob.token)).toEqual(bob.actor); expect(auth.authenticate(alice.token)).toEqual(alice.actor);
});
it.each([null, "null", "https://evil.invalid", `${origin}/`])("requires canonical origin %s", async source => {
  expect((await Goals.POST(request("POST", {}, alice, source))).status).toBe(403);
});
it("rejects an oversized streamed body without a content-length header", async () => {
  const response = await Goals.POST(request("POST", { category: "learning", initialMessage: "x".repeat(256 * 1024) }, alice));
  expect(response.status).toBe(413);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("keeps invite model policy read-only for members and admins", async () => {
  for (const session of [alice, bob]) {
    const setting = await services.settings.get(session.actor.ownerId);
    for (const patch of [{ provider: "qwen" }, { provider: "deepseek" }, { fallbackEnabled: true }, { dailyInputTokenLimit: 999999 }, { dailyOutputTokenLimit: 999999 }])
      expect((await Settings.PATCH(request("PATCH", { expectedVersion: setting.version, ...patch }, session))).status).toBe(403);
    expect((await Settings.PATCH(request("PATCH", { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: setting.provider, privacyPolicyVersion: "2026-09-24" }, session))).status).toBe(200);
  }
});
