import { expect, it } from "vitest";
import { AppError, toSafeErrorResponse } from "@/core/errors/app-error";
import { AgentTurnError, AgentTurnFailureSchema, toAgentTurnError } from "./agent-turn-error";

it.each(["APPROVAL_REQUIRED", "VERSION_CONFLICT", "OWNERSHIP_MISMATCH", "MODEL_TIMEOUT"] as const)("preserves %s and detached safe metadata through replay", code => {
  const original = new AppError(code, 409, "private provider response", "private detail");
  const context = { state: "plan_review" as const, persistedChange: true };
  const error = toAgentTurnError(original, context);
  context.persistedChange = false;
  const replay = new AgentTurnError(AgentTurnFailureSchema.parse({ code: error.code, status: error.status, ...error.turn }));
  expect(error).toBeInstanceOf(AppError);
  expect(error.turn).toEqual({ state: "plan_review", persistedChange: true });
  expect(Object.isFrozen(error.turn)).toBe(true);
  expect(replay.turn).toEqual(error.turn);
  expect(toSafeErrorResponse(replay)).toEqual(toSafeErrorResponse(error));
  expect(JSON.stringify(error)).not.toMatch(/private|cause|original/);
  expect(error.name).toBe("AppError");
});

it("normalizes secret-bearing unknown exceptions without retaining any source", () => {
  const error = toAgentTurnError(new Error("sensitive provider body"), { state: null, persistedChange: false });
  expect(error).toMatchObject({ code: "DATABASE_ERROR", status: 500, turn: { state: null, persistedChange: false } });
  expect(JSON.stringify(error)).not.toContain("sensitive");
  expect(error).not.toHaveProperty("cause");
});

it.each(["MODEL_AUTH_FAILED", "MODEL_BALANCE_INSUFFICIENT", "MODEL_UNAVAILABLE", "MODEL_RATE_LIMITED"] as const)("persists provider failure %s without replacing its code", code => {
  const original = new AppError(code, 503, "private provider body");
  const error = toAgentTurnError(original, { state: null, persistedChange: false });
  expect(AgentTurnFailureSchema.parse({ code: error.code, status: error.status, ...error.turn }).code).toBe(code);
  expect(JSON.stringify(error)).not.toContain("private provider body");
});

it.each([399, 600, 400.5, NaN])("rejects non-HTTP-error status %s", status => {
  expect(() => new AgentTurnError({ code: "DATABASE_ERROR", status, state: null, persistedChange: false })).toThrow();
});

it("rejects extra cached fields and invalid codes; invalid AppError metadata fails closed", () => {
  expect(AgentTurnFailureSchema.safeParse({ code: "DATABASE_ERROR", status: 500, state: null, persistedChange: false, detail: "private" }).success).toBe(false);
  const error = toAgentTurnError(new AppError("invented" as never, 200, "private"), { state: "intake", persistedChange: false });
  expect(error).toMatchObject({ code: "DATABASE_ERROR", status: 500 });
});
