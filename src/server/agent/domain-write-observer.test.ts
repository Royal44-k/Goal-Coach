import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { contentHash } from "../security/canonical-json";
import { observeDomainWrites, goalCheckpoint } from "./domain-write-observer";
import type { PlanRevisionPayload } from "../repositories/revision-contracts";

const owner = LOCAL_OWNER_ID;
const contract = { title: "目标", category: "learning" as const, desiredOutcome: "理解", definitionOfDone: "复述", deadline: "2026-12-31", weeklyMinutes: 60, constraints: [], motivation: "兴趣" };
let db: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
beforeEach(() => { db = createDatabase(":memory:"); migrateDatabase(db); repositories = createRepositories(db); });
afterEach(() => db.$client.close());

it("records only successful writes and keeps facade expiry and savepoints intact", async () => {
  let escaped!: ReturnType<typeof observeDomainWrites>;
  await repositories.withTransaction(tx => {
    const observer = observeDomainWrites(tx); escaped = observer;
    expect(() => observer.repositories.goals.create(owner, { ...contract, title: "" })).toThrow();
    expect(observer.hasDomainWrite()).toBe(false);
    expect(tx.goals.list(owner)).toEqual([]);
    observer.repositories.goals.create(owner, contract);
    expect(observer.hasDomainWrite()).toBe(true);
  });
  expect(() => escaped.repositories.goals.create(owner, contract)).toThrow();
  expect(await repositories.goals.list(owner)).toHaveLength(1);
});

it("does not mark absent goal deletion but marks actual deletion and detached nullable checkpoints", async () => {
  expect(goalCheckpoint(null)).toBeNull();
  const goal = await repositories.goals.create(owner, contract);
  const checkpoint = goalCheckpoint(goal);
  goal.title = "local object edit";
  expect(Object.keys(checkpoint!)).toEqual(["id", "version", "agentState", "status", "currentPlanVersionId"]);
  await repositories.withTransaction(tx => {
    const observer = observeDomainWrites(tx);
    observer.repositories.goals.delete(owner, randomUUID());
    expect(observer.hasDomainWrite()).toBe(false);
    observer.repositories.goals.delete(owner, goal.id);
    expect(observer.hasDomainWrite()).toBe(true);
    expect(tx.goals.get(owner, goal.id)).toBeNull();
  });
});

it.each([false, true])("counts clear from formal-domain deletion counts only, domain=%s", async domain => {
  if (domain) await repositories.goals.create(owner, contract);
  const counts = await repositories.withTransaction(tx => {
    tx.support.createAppSetting(owner, { privacyAcceptedAt: null, privacyProvider: null, privacyPolicyVersion: null, provider: "mock", model: "mock", fallbackEnabled: false, dailyInputTokenLimit: 100, dailyOutputTokenLimit: 100 });
    const operation = tx.support.createOperation(owner, { goalId: null, toolName: "clear_all_data", operationId: "clear", parameterHash: "a".repeat(64) });
    const observer = observeDomainWrites(tx);
    const deleted = observer.repositories.support.clearOwnerData(owner, operation.id);
    expect(observer.hasDomainWrite()).toBe(domain);
    return deleted;
  });
  expect(counts.goals).toBe(domain ? 1 : 0); expect(counts.settings).toBe(1);
});

it("records empty task materialization because it changes the plan envelope version", async () => {
  const goal = await repositories.goals.create(owner, contract);
  const payload: PlanRevisionPayload = { schemaVersion: 2, milestones: ["基础", "应用"], base: { planVersionId: null, goalVersion: goal.version }, changeSource: "agent", changeReason: null, tasks: [], executionResets: [], diff: { added: [], removed: [], moved: [], changed: [] } };
  const artifact = await repositories.plans.saveDraftArtifact(owner, { goalId: goal.id, kind: "plan", payload, contentHash: contentHash(payload) });
  const plan = await repositories.plans.createDraft(owner, goal.id, { draftArtifactId: artifact.id, expectedDraftArtifactVersion: artifact.version });
  await repositories.withTransaction(tx => {
    const observer = observeDomainWrites(tx);
    expect(observer.repositories.tasks.createMany(owner, goal.id, plan.id, [])).toEqual([]);
    expect(observer.hasDomainWrite()).toBe(true);
    expect(tx.plans.listVersions(owner, goal.id)[0].version).toBe(plan.version + 1);
    expect(tx.goals.get(owner, goal.id)!.version).toBe(goal.version);
  });
});
