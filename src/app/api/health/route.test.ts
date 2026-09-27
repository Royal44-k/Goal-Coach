import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

let root: string;
let databasePath: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "goal-coach-health-"));
  databasePath = path.join(root, "synthetic.db");
  vi.stubEnv("APP_MODE", "invite");
  vi.stubEnv("APP_ORIGIN", "https://coach.example.com");
  vi.stubEnv("DATABASE_PATH", databasePath);
  vi.stubEnv("MODEL_PROVIDER", "mock");
  vi.stubEnv("DASHSCOPE_API_KEY", "");
  vi.stubEnv("DASHSCOPE_BASE_URL", "");
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com");
  vi.stubEnv("DAILY_AGENT_TURN_LIMIT", "50");
});
test("DeepSeek health needs its own key and only reads the local database", async () => {
  const database = new Database(databasePath);
  database.exec("CREATE TABLE synthetic_rows(id INTEGER PRIMARY KEY)");
  database.close();
  const before = await readFile(databasePath);
  vi.stubEnv("MODEL_PROVIDER", "deepseek");
  vi.stubEnv("DASHSCOPE_API_KEY", "synthetic-qwen-secret");
  const { GET } = await import("./route");
  expect(GET().status).toBe(503);
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-deepseek-secret");
  const response = GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(await readFile(databasePath)).toEqual(before);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test("health checks a real database read-only and accepts mock with blank model credentials", async () => {
  const database = new Database(databasePath);
  database.exec("CREATE TABLE synthetic_rows(id INTEGER PRIMARY KEY); INSERT INTO synthetic_rows VALUES(1)");
  database.close();
  const before = await readFile(databasePath);
  const { GET } = await import("./route");
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true });
  expect(await readFile(databasePath)).toEqual(before);
});

test("missing database reports unavailable without creating a database or its directory", async () => {
  vi.stubEnv("DATABASE_PATH", path.join(root, "missing", "private.db"));
  const { GET } = await import("./route");
  const response = GET();
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: false });
  expect(await readdir(root)).toEqual([]);
});

test("corrupt database reports only safe unavailable state and preserves bytes", async () => {
  const bytes = Buffer.from("synthetic-private-database-content");
  await writeFile(databasePath, bytes);
  const { GET } = await import("./route");
  const response = GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false });
  expect(await readFile(databasePath)).toEqual(bytes);
});

for (const invalid of [{ APP_ORIGIN: "http://public.example.com" }, { DAILY_AGENT_TURN_LIMIT: "0" }, { MODEL_PROVIDER: "qwen" }]) {
  test(`invalid local configuration reports safe unavailable state: ${JSON.stringify(invalid)}`, async () => {
    const database = new Database(databasePath);
    database.exec("CREATE TABLE synthetic_rows(id INTEGER PRIMARY KEY)");
    database.close();
    vi.stubEnv("DASHSCOPE_API_KEY", "synthetic-health-secret");
    for (const [key, value] of Object.entries(invalid)) vi.stubEnv(key, value);
    const { GET } = await import("./route");
    const response = GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false });
  });
}
