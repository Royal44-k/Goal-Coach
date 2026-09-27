import { describe, expect, it } from "vitest";
import type { AgentState } from "../domain/contracts";
import { canTransition, recoverState, transition } from "./agent-state-machine";

const states: readonly AgentState[] = [
  "intake",
  "clarifying",
  "contract_review",
  "planning",
  "plan_review",
  "active",
  "reviewing",
  "replanning",
  "paused",
  "completed",
  "failed_recoverable",
];

const allowedTransitions: Readonly<Record<AgentState, readonly AgentState[]>> = {
  intake: ["clarifying", "contract_review", "failed_recoverable"],
  clarifying: ["clarifying", "contract_review", "failed_recoverable"],
  contract_review: ["clarifying", "planning", "failed_recoverable"],
  planning: ["plan_review", "failed_recoverable"],
  plan_review: ["planning", "active", "failed_recoverable"],
  active: ["reviewing", "replanning", "paused", "failed_recoverable"],
  reviewing: ["active", "replanning", "completed", "failed_recoverable"],
  replanning: ["plan_review", "active", "failed_recoverable"],
  paused: ["active", "failed_recoverable"],
  completed: [],
  failed_recoverable: [
    "intake",
    "clarifying",
    "contract_review",
    "planning",
    "plan_review",
    "active",
    "paused",
  ],
};

describe("agent state machine", () => {
  it("allows the specified initial and self transitions", () => {
    expect(canTransition("intake", "clarifying")).toBe(true);
    expect(canTransition("intake", "contract_review")).toBe(true);
    expect(canTransition("clarifying", "clarifying")).toBe(true);
    expect(canTransition("intake", "active")).toBe(false);
  });

  it("rejects invalid transitions with a stable application error", () => {
    expect(() => transition("plan_review", "completed")).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });

  it("returns each formal recovery destination and rejects unsafe recovery inputs", () => {
    expect(recoverState("active")).toBe("active");
    expect(recoverState("planning")).toBe("planning");
    expect(recoverState("reviewing")).toBe("active");
    expect(recoverState("replanning")).toBe("active");
    expect(() => recoverState("completed")).toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    expect(() => recoverState("failed_recoverable")).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });

  it("visits all states, permits every listed edge, and rejects an unlisted edge", () => {
    for (const from of states) {
      for (const to of allowedTransitions[from]) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
        expect(transition(from, to)).toBe(to);
      }

      const rejectedTarget = states.find((to) => !allowedTransitions[from].includes(to));
      expect(rejectedTarget, `${from} should have an unlisted edge`).toBeDefined();
      expect(canTransition(from, rejectedTarget!)).toBe(false);
      expect(() => transition(from, rejectedTarget!)).toThrowError(
        expect.objectContaining({ code: "INVALID_TRANSITION" }),
      );
    }
  });
});
