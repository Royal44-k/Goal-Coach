import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toSafeErrorResponse } from "../src/core/errors/app-error";
import { AuthService } from "../src/server/auth/auth-service";
import { loadAuthConfig } from "../src/server/auth/auth-config";
import { createDatabase, type AppDatabase } from "../src/server/db/client";
import { migrateDatabase } from "../src/server/db/migrate";

async function stdinPassword(): Promise<string> {
  // Piped stdin avoids echoing typed passwords in an ordinary terminal.
  if (process.stdin.isTTY) throw new Error("Pipe password through stdin");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 514) throw new Error("Input too large");
    chunks.push(bytes);
  }
  // Strip one transport newline; preserve password spaces and other characters.
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  let db: AppDatabase | undefined;
  try {
    const args = process.argv.slice(2);
    if (!((args[0] === "bootstrap" && args.length === 1)
      || (args[0] === "reset-password" && args.length === 2))) {
      console.error("用法：auth:admin bootstrap | auth:admin reset-password <账号名>（新密码从 stdin 管道读取）");
      process.exitCode = 1;
      return;
    }
    loadAuthConfig();
    const path = process.env.DATABASE_PATH;
    if (!path?.trim()) throw new Error("DATABASE_PATH required");
    const password = args[0] === "reset-password" ? await stdinPassword() : undefined;
    db = createDatabase(path);
    migrateDatabase(db);
    const service = new AuthService({ database: db });
    if (args[0] === "bootstrap") {
      const invite = service.bootstrapAdminInvite();
      console.info(`管理员邀请码（仅本次显示，请私下保存）：${invite.token}`);
      console.info(`有效期至：${new Date(invite.expiresAt).toISOString()}`);
    } else {
      await service.resetPassword(args[1], password!);
      console.info("密码已重置，已有会话已撤销。");
    }
  } catch (error) {
    console.error(`账号管理操作失败。${toSafeErrorResponse(error).message}`);
    process.exitCode = 1;
  } finally { db?.$client.close(); }
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (executedPath === import.meta.url) await main();
