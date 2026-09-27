import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AppError } from "../../core/errors/app-error";

const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const prefix = "scrypt$32768$8$3";
// Valid fixed-format hash used only to perform bounded work for missing users.
export const DUMMY_PASSWORD_HASH = `${prefix}$${"00".repeat(16)}$${"00".repeat(64)}`;
let passwordJobs = 0;
export async function withPasswordJob<T>(work: () => Promise<T>): Promise<T> {
  if (passwordJobs >= 2) throw new AppError("AUTH_RATE_LIMITED", 429, "Password workers busy");
  passwordJobs++;
  try { return await work(); } finally { passwordJobs--; }
}
export function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, parameters,
    (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new AppError("VALIDATION_ERROR", 400, "Invalid password length");
  const salt = randomBytes(16);
  return `${prefix}$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!validPassword(password) || !/^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash)) return false;
  const parts = hash.split("$");
  const actual = await derive(password, Buffer.from(parts[4], "hex"));
  return timingSafeEqual(actual, Buffer.from(parts[5], "hex"));
}
export type PasswordHasher = { hash: typeof hashPassword; verify: typeof verifyPassword };
