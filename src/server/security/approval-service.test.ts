import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { ApprovalService } from "./approval-service";
import { canonicalJson, contentHash } from "./canonical-json";

const ownerId = "00000000-0000-4000-8000-000000000001";
let database: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
let approvals: ApprovalService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-15T04:00:00.000Z");
  database = createDatabase(":memory:");
  migrateDatabase(database);
  repositories = createRepositories(database);
  approvals = new ApprovalService(repositories.support);
});

afterEach(() => {
  database?.$client.close();
  vi.useRealTimers();
});

describe("canonical JSON", () => {
  it("sorts object keys recursively while retaining array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }, 3], a: true }))
      .toBe('{"a":true,"z":[{"a":1,"b":2},3]}');
    expect(contentHash({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it.each([
    { bad: undefined },
    { bad: Number.NaN },
    { bad: Number.POSITIVE_INFINITY },
    { bad: () => 1 },
    { bad: Symbol("secret") },
  ])("rejects a non-JSON value", (value) => {
    expect(() => canonicalJson(value)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("rejects one-hole and multi-hole sparse arrays", () => {
    const oneHole = new Array<unknown>(1);
    const multiHole = new Array<unknown>(3);
    multiHole[1] = "present";

    for (const sparse of [oneHole, multiHole]) {
      expect(() => canonicalJson(sparse)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
    expect(() => canonicalJson([undefined])).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(canonicalJson([])).toBe("[]");
  });
});

describe("ApprovalService", () => {
  it("binds a grant to owner, subject, tool and canonical payload, then consumes it once", async () => {
    const subjectId = randomUUID();
    const payload = { title: "学习 TS", nested: { b: 2, a: 1 } };
    const grant = await approvals.issue({
      ownerId,
      subjectId,
      toolName: "save_approved_plan",
      payload,
    });

    await expect(approvals.consume({
      ownerId,
      grantId: grant.id,
      subjectId,
      toolName: "save_approved_plan",
      payload: { nested: { a: 1, b: 2 }, title: "学习 TS" },
    })).resolves.toMatchObject({ usedAt: expect.any(String), version: 2 });
    await expect(approvals.consume({
      ownerId,
      grantId: grant.id,
      subjectId,
      toolName: "save_approved_plan",
      payload,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("returns the same safe error for every changed binding", async () => {
    const subjectId = randomUUID();
    const grant = await approvals.issue({
      ownerId,
      subjectId,
      toolName: "save_approved_plan",
      payload: { title: "学习 TS" },
    });
    const attempts = [
      { ownerId: "00000000-0000-4000-8000-000000000002" },
      { subjectId: randomUUID() },
      { toolName: "delete_goal" },
      { payload: { title: "被替换" } },
    ];

    for (const changed of attempts) {
      await expect(approvals.consume({
        ownerId,
        grantId: grant.id,
        subjectId,
        toolName: "save_approved_plan",
        payload: { title: "学习 TS" },
        ...changed,
      })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    }

    await expect(approvals.consume({
      ownerId,
      grantId: grant.id,
      subjectId: "not-a-uuid",
      toolName: "save_approved_plan",
      payload: { title: "学习 TS" },
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("expires exactly at the fifteen-minute boundary", async () => {
    const subjectId = randomUUID();
    const grant = await approvals.issue({
      ownerId,
      subjectId,
      toolName: "delete_task",
      payload: { expectedVersion: 1 },
    });
    expect(grant.expiresAt).toBe("2026-09-15T04:15:00.000Z");

    vi.setSystemTime("2026-09-15T04:15:00.000Z");
    await expect(approvals.consume({
      ownerId,
      grantId: grant.id,
      subjectId,
      toolName: "delete_task",
      payload: { expectedVersion: 1 },
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("issues through a supplied transaction facade and rolls back with its caller", async () => {
    await expect(repositories.withTransaction(tx => {
      approvals.issueInTransaction(tx.support, {
        ownerId,
        subjectId: randomUUID(),
        toolName: "delete_goal",
        payload: { expectedVersion: 1 },
      });
      throw new Error("rollback issue");
    })).rejects.toThrow("rollback issue");

    expect(database.$client.prepare("SELECT count(*) AS count FROM approval_grants").get())
      .toEqual({ count: 0 });
  });
});
