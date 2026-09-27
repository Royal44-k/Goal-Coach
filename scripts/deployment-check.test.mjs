import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const script = fileURLToPath(new URL("./deployment-check.mjs", import.meta.url));
function check(overrides) {
  return spawnSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, APP_MODE: "invite", APP_ORIGIN: "https://coach.example.com",
      DATABASE_PATH: "/app/data/goal-coach.db", MODEL_PROVIDER: "mock",
      DASHSCOPE_API_KEY: "", DASHSCOPE_BASE_URL: "", DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_MODEL: "deepseek-flash", ...overrides },
    encoding: "utf8", timeout: 15_000,
  });
}
test("DeepSeek deployment requires its own credentials and never prints them", () => {
  const configured = { MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-deepseek-secret" };
  assert.equal(check(configured).status, 0);
  const missing = check({ ...configured, DEEPSEEK_API_KEY: "", DASHSCOPE_API_KEY: "synthetic-qwen-secret", DASHSCOPE_BASE_URL: "https://example.test/v1" });
  assert.equal(missing.status, 1);
  assert.equal(`${missing.stdout}${missing.stderr}`.includes("synthetic-qwen-secret"), false);
  const qwen = check({ MODEL_PROVIDER: "qwen", DEEPSEEK_API_KEY: "synthetic-deepseek-secret" });
  assert.equal(qwen.status, 1);
});
test("deployment example supports blank provider credentials without opening a database", async () => {
  const example = parseEnv(await readFile(new URL("../deploy/.env.example", import.meta.url), "utf8"));
  const result = check({ ...example, APP_ORIGIN: "https://coach.example.com" });
  assert.equal(result.status, 0, result.stderr);
});
for (const invalid of [
  { APP_MODE: "local" }, { APP_ORIGIN: "http://public.example.com" },
  { DATABASE_PATH: "" }, { DATABASE_PATH: ":memory:" }, { DAILY_AGENT_TURN_LIMIT: "0" },
  { MODEL_PROVIDER: "qwen" }, { ENABLE_QWEN_FALLBACK: "yes" },
]) {
  test(`deployment rejects invalid configuration ${JSON.stringify(invalid)}`, () => {
    const result = check({ ...invalid, DASHSCOPE_API_KEY: "synthetic-configuration-secret" });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("部署配置无效"), result.stderr);
    assert.equal(`${result.stderr}${result.stdout}`.includes("synthetic-configuration-secret"), false);
  });
}
