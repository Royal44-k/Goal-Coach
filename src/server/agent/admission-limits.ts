import { AppError } from "@/core/errors/app-error";
import { z } from "zod";
const activeOwners = new Set<string>();
export function dailyAgentTurnLimit(): number {
  const value = z.coerce.number().int().min(1).max(1000).safeParse(process.env.DAILY_AGENT_TURN_LIMIT ?? "50");
  if (!value.success) throw new AppError("VALIDATION_ERROR", 500, "Invalid daily agent limit");
  return value.data;
}
/** Single Node process only; no queue. Always release in the service's finally block. */
export function acquireAgentLease(owner: string): () => void {
  if (activeOwners.has(owner) || activeOwners.size >= 2) throw new AppError("AUTH_RATE_LIMITED", 429, "Agent concurrency limit reached");
  activeOwners.add(owner); let released = false;
  return () => { if (!released) { released = true; activeOwners.delete(owner); } };
}
const shanghaiDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
export function agentAdmissionDay(now: Date): string { return shanghaiDay.format(now); }
