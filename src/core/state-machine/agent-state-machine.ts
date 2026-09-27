import type { AgentState } from "../domain/contracts";
import { AppError } from "../errors/app-error";

const transitions: Readonly<Record<AgentState, readonly AgentState[]>> = {
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

const recoveryStates: Readonly<Partial<Record<AgentState, AgentState>>> = {
  intake: "intake",
  clarifying: "clarifying",
  contract_review: "contract_review",
  planning: "planning",
  plan_review: "plan_review",
  active: "active",
  reviewing: "active",
  replanning: "active",
  paused: "paused",
};

function invalidTransition(from: AgentState, to: AgentState): AppError {
  return new AppError("INVALID_TRANSITION", 409, `Invalid transition: ${from} -> ${to}`);
}

export function canTransition(from: AgentState, to: AgentState): boolean {
  return transitions[from].includes(to);
}

export function transition(from: AgentState, to: AgentState): AgentState {
  if (!canTransition(from, to)) {
    throw invalidTransition(from, to);
  }

  return to;
}

export function recoverState(lastSafeState: AgentState): AgentState {
  const recoveredState = recoveryStates[lastSafeState];

  if (recoveredState === undefined) {
    throw invalidTransition("failed_recoverable", lastSafeState);
  }

  return recoveredState;
}
