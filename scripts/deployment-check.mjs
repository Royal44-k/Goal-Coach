import { loadAuthConfig } from "../src/server/auth/auth-config.ts";
import { loadServerEnv, requireQwenConfig } from "../src/server/config/env.ts";
import { requireDeepSeekConfig } from "../src/server/config/deepseek-config.ts";
import { dailyAgentTurnLimit } from "../src/server/agent/admission-limits.ts";

try {
  const auth = loadAuthConfig();
  const databasePath = process.env.DATABASE_PATH?.trim();
  if (auth.mode !== "invite" || !databasePath || databasePath === ":memory:") throw new Error("invalid deployment");
  const model = loadServerEnv();
  if (model.provider === "qwen") requireQwenConfig(model);
  if (model.provider === "deepseek") requireDeepSeekConfig(model.deepseek);
  dailyAgentTurnLimit();
  console.info("部署配置检查通过（未访问数据库或模型网络）。");
} catch {
  console.error("部署配置无效。请私下检查邀请模式、Origin、数据库路径和模型/配额环境变量。");
  process.exitCode = 1;
}
