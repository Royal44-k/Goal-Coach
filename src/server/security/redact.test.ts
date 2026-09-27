import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { AuditService } from "../audit/audit-service";
import { redactSensitive } from "./redact";

const ownerId = "00000000-0000-4000-8000-000000000001";
let database: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;

beforeEach(() => {
  database = createDatabase(":memory:");
  migrateDatabase(database);
  repositories = createRepositories(database);
});

afterEach(() => database?.$client.close());

it("redacts bearer, sk-prefixed and secret assignment values", () => {
  expect(redactSensitive("Bearer sk-live-secret DASHSCOPE_API_KEY=abc"))
    .toBe("Bearer [REDACTED] DASHSCOPE_API_KEY=[REDACTED]");
  expect(redactSensitive("token=abc password='hidden' clientSecret=xyz sk-demo-123"))
    .toBe("token=[REDACTED] password=[REDACTED] clientSecret=[REDACTED] [REDACTED]");
});

it("consumes escaped delimiters inside both quoted assignment styles", () => {
  expect(redactSensitive(String.raw`password="first\"remaining-secret"`))
    .toBe("password=[REDACTED]");
  expect(redactSensitive(String.raw`api_secret='first\'remaining-secret'`))
    .toBe("api_secret=[REDACTED]");
});

it("recursively redacts structured audit details before persistence", async () => {
  const audit = new AuditService(repositories.support);
  const event = await audit.record({
    ownerId,
    goalId: null,
    type: "security_test",
    entityType: "owner",
    entityId: ownerId,
    detail: {
      apiKey: "abc",
      nested: ["Bearer live-token", { note: "password=hunter2" }],
      safe: "保留",
    },
  });
  const serialized = JSON.stringify(event.detail);

  expect(event.detail).toEqual({
    apiKey: "[REDACTED]",
    nested: ["Bearer [REDACTED]", { note: "password=[REDACTED]" }],
    safe: "保留",
  });
  expect(serialized).not.toContain("abc");
  expect(serialized).not.toContain("live-token");
  expect(serialized).not.toContain("hunter2");
});

it("records through a supplied transaction facade and rolls back with its caller", async () => {
  const audit = new AuditService(repositories.support);

  await expect(repositories.withTransaction(tx => {
    audit.recordInTransaction(tx.support, {
      ownerId,
      goalId: null,
      type: "rolled_back",
      entityType: "owner",
      entityId: ownerId,
      detail: { token: "must-not-persist" },
    });
    throw new Error("rollback audit");
  })).rejects.toThrow("rollback audit");

  expect(database.$client.prepare("SELECT count(*) AS count FROM audit_events").get())
    .toEqual({ count: 0 });
});

it("persists no suffix from escaped quoted credentials", async () => {
  const audit = new AuditService(repositories.support);
  const event = await audit.record({
    ownerId,
    goalId: null,
    type: "escaped_quote_test",
    entityType: "owner",
    entityId: ownerId,
    detail: {
      note: String.raw`password="first\"remaining-secret"`,
      alternate: String.raw`token='second\'remaining-secret'`,
    },
  });
  const serialized = JSON.stringify(event.detail);

  expect(event.detail).toEqual({
    note: "password=[REDACTED]",
    alternate: "token=[REDACTED]",
  });
  expect(serialized).not.toContain("remaining-secret");
  expect(serialized).not.toContain("first");
  expect(serialized).not.toContain("second");
});
