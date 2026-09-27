import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "./repository-factory";
import type { TransactionRepositories } from "./repository-types";
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const input = {
  title: "学习", category: "learning" as const, desiredOutcome: "读懂", definitionOfDone: "完成", deadline: "2026-12-31", weeklyMinutes: 60, constraints: [], motivation: "兴趣"
};
let db: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
beforeEach(() => {
  db = createDatabase(":memory:");
  migrateDatabase(db);
  repositories = createRepositories(db);
});
afterEach(() => db?.$client.close());
describe("owner-scoped repositories", () => {
  it("hides other owners and rejects stale goal versions", async () => {
    const goal = await repositories.goals.create(owner, input);
    expect(await repositories.goals.get(other, goal.id)).toBeNull();
    expect(await repositories.goals.list(other)).toEqual([]);
    await expect(repositories.goals.update(owner, goal.id, 99, {
      title: "覆盖"
    })).rejects.toMatchObject({
      code: "VERSION_CONFLICT"
    });
    const updated = await repositories.goals.update(owner, goal.id, 1, {
      title: "新标题"
    });
    expect(updated).toMatchObject({
      title: "新标题", version: 2, ownerId: owner
    });
  });
  it("rolls back a real earlier write when the later write is invalid", async () => {
    await expect(repositories.withTransaction((tx) => {
      const goal = tx.goals.create(owner, input);
      expect(tx.goals.get(owner, goal.id)).not.toBeNull();
      tx.goals.create(owner, {
        ...input, title: ""
      });
    })).rejects.toBeDefined();
    expect(await repositories.goals.list(owner)).toEqual([]);
  });
  it("expires escaped facades and rejects async callbacks before commit", async () => {
    if (false) {
      // @ts-expect-error Unit-of-work callbacks must return a non-thenable.
      void repositories.withTransaction(async () => 1);
    }
    let escaped!: TransactionRepositories;
    await repositories.withTransaction((tx) => {
      escaped = tx;
    });
    expect(() => escaped.goals.list(owner)).toThrow();
    let late!: Promise<void>;
    const invalid = (tx: TransactionRepositories) => {
      late = (async () => {
        tx.goals.create(owner, input);
        await Promise.resolve();
        tx.goals.create(owner, input);
      })();
      return late;
    };
    // Deliberately defeat the compile-time rejection to test the runtime guard.
    await expect(repositories.withTransaction(invalid as never)).rejects.toBeDefined();
    await expect(late).rejects.toBeDefined();
    expect(await repositories.goals.list(owner)).toEqual([]);
  });
  it("rejects mass assignment and parses malformed stored rows on read", async () => {
    await expect(repositories.goals.create(owner, {
      ...input, ownerId: other
    } as never)).rejects.toBeDefined();
    const goal = await repositories.goals.create(owner, input);
    await expect(repositories.goals.update(owner, goal.id, goal.version, {
      currentPlanVersionId: other
    } as never)).rejects.toBeDefined();
    db.$client.prepare("UPDATE goals SET constraints = ? WHERE id = ?").run('{"invalid":true}', goal.id);
    await expect(repositories.goals.get(owner, goal.id)).rejects.toBeDefined();
  });
  it("keeps a failed repository operation atomic even if its error is caught by the outer transaction", async () => {
    await repositories.withTransaction(tx => {
      const goal = tx.goals.create(owner, input);
      try {
        tx.goals.update(owner, goal.id, 1, {
          status: "active", desiredOutcome: null
        });
      }
      catch { /* The outer operation deliberately continues. */
      }
      expect(tx.goals.get(owner, goal.id)).toEqual(goal);
    });
    expect(await repositories.goals.list(owner)).toHaveLength(1);
  });
});
