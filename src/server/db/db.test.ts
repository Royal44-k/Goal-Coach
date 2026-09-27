import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "./client";
import { migrateDatabase } from "./migrate";

const expectedTables = [
  "goals",
  "tasks",
  "plan_versions",
  "draft_artifacts",
  "check_ins",
  "task_evidence",
  "agent_runs",
  "approval_grants",
  "operations",
  "undo_records",
  "conversation_messages",
  "conversation_summaries",
  "user_preferences",
  "audit_events",
  "app_settings",
] as const;

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "goal-coach-db-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite database foundation", () => {
  test("creates every domain table and can apply the migration repeatedly", () => {
    const database = createDatabase(":memory:");

    try {
      migrateDatabase(database);
      migrateDatabase(database);

      const names = database.$client
        .prepare("select name from sqlite_master where type = 'table'")
        .all();

      expect(names).toEqual(
        expect.arrayContaining(
          expectedTables.map((name) => expect.objectContaining({ name })),
        ),
      );
      expect(
        database.$client
          .prepare("select count(*) as count from __drizzle_migrations")
          .get(),
      ).toEqual({ count: 5 });
      const privacyColumns = database.$client.pragma("table_info(app_settings)") as Array<{ name: string; notnull: number }>;
      expect(privacyColumns.filter(column => ["privacy_provider", "privacy_policy_version"].includes(column.name)))
        .toEqual([expect.objectContaining({ name: "privacy_provider", notnull: 0 }), expect.objectContaining({ name: "privacy_policy_version", notnull: 0 })]);
    } finally {
      database.$client.close();
    }
  });

  test("enforces foreign keys in the live connection", () => {
    const database = createDatabase(":memory:");

    try {
      migrateDatabase(database);

      expect(database.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() =>
        database.$client
          .prepare(
            `insert into tasks (
              id, owner_id, goal_id, plan_version_id, title, action,
              done_criteria, evidence_type, estimate_minutes, dependency_ids,
              status, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
            "00000000-0000-4000-8000-000000000003",
            "00000000-0000-4000-8000-000000000004",
            "任务",
            "行动",
            "完成标准",
            "text",
            30,
            "[]",
            "todo",
            1_788_000_000_000,
            1_788_000_000_000,
          ),
      ).toThrow(/foreign key/i);
    } finally {
      database.$client.close();
    }
  });

  test("gives every owner-scoped table an owner index and version default", () => {
    const database = createDatabase(":memory:");

    try {
      migrateDatabase(database);

      for (const table of expectedTables) {
        const columns = database.$client.pragma(`table_info(${table})`) as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>;
        const ownerColumn = columns.find(({ name }) => name === "owner_id");
        const versionColumn = columns.find(({ name }) => name === "version");
        const indexes = database.$client.pragma(`index_list(${table})`) as Array<{
          name: string;
        }>;

        expect(ownerColumn, `${table}.owner_id`).toMatchObject({ notnull: 1 });
        expect(versionColumn, `${table}.version`).toMatchObject({
          notnull: 1,
          dflt_value: "1",
        });
        expect(indexes.map(({ name }) => name)).toContain(`${table}_owner_idx`);
      }
    } finally {
      database.$client.close();
    }
  });

  test("rejects duplicate operation and approval protocol identifiers", () => {
    const database = createDatabase(":memory:");

    try {
      migrateDatabase(database);
      const insertOperation = database.$client.prepare(
        `insert into operations (
          id, owner_id, goal_id, operation_id, tool_name, parameter_hash,
          status, created_at, updated_at
        ) values (?, ?, null, ?, ?, ?, ?, ?, ?)`,
      );
      const operationValues = [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
        "clear-all:request-1",
        "clear_all_data",
        "a".repeat(64),
        "pending",
        1_788_000_000_000,
        1_788_000_000_000,
      ] as const;

      insertOperation.run(...operationValues);
      expect(() =>
        insertOperation.run(
          "00000000-0000-4000-8000-000000000013",
          operationValues[1],
          ...operationValues.slice(2),
        ),
      ).toThrow(/unique/i);

      const insertGrant = database.$client.prepare(
        `insert into approval_grants (
          id, owner_id, subject_id, content_hash, allowed_tool, expires_at,
          used_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, null, ?, ?)`,
      );
      const grantValues = [
        "00000000-0000-4000-8000-000000000021",
        "00000000-0000-4000-8000-000000000022",
        "00000000-0000-4000-8000-000000000023",
        "b".repeat(64),
        "approve_plan",
        1_788_000_900_000,
        1_788_000_000_000,
        1_788_000_000_000,
      ] as const;

      insertGrant.run(...grantValues);
      expect(() => insertGrant.run(...grantValues)).toThrow(/unique/i);
    } finally {
      database.$client.close();
    }
  });

  test("uses real affinity for fractional preference estimate bias", () => {
    const database = createDatabase(":memory:");

    try {
      migrateDatabase(database);
      const columns = database.$client.pragma("table_info(user_preferences)") as Array<{
        name: string;
        type: string;
      }>;

      expect(columns.find(({ name }) => name === "estimate_bias")).toMatchObject({
        type: "REAL",
      });
    } finally {
      database.$client.close();
    }
  });

  test("creates a file database parent and enables WAL", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "nested", "coach.db");
    const database = createDatabase(databasePath);

    try {
      migrateDatabase(database);
      expect(existsSync(databasePath)).toBe(true);
      expect(database.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      database.$client.close();
    }

    const movedPath = join(dirname(databasePath), "closed.db");
    await rename(databasePath, movedPath);
    expect(existsSync(movedPath)).toBe(true);
  });

  test("importing migration helpers does not execute the CLI", async () => {
    const directory = await makeTemporaryDirectory();
    const sentinelPath = join(directory, "must-not-exist.db");
    const previousDatabasePath = process.env.DATABASE_PATH;

    try {
      process.env.DATABASE_PATH = sentinelPath;
      vi.resetModules();
      await import("./migrate");
      expect(existsSync(sentinelPath)).toBe(false);
    } finally {
      if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousDatabasePath;
      }
    }
  });
});
