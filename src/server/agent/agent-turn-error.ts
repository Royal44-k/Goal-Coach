import { z } from "zod";
import { AgentStateSchema } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";

export const AgentTurnFailureSchema = z.object({
  code: z.enum(["VALIDATION_ERROR", "NOT_FOUND", "OWNERSHIP_MISMATCH", "INVALID_TRANSITION", "APPROVAL_REQUIRED", "APPROVAL_INVALID", "VERSION_CONFLICT", "MODEL_CONFIG_MISSING", "MODEL_AUTH_FAILED", "MODEL_BALANCE_INSUFFICIENT", "MODEL_UNAVAILABLE", "MODEL_RATE_LIMITED", "MODEL_TIMEOUT", "MODEL_RESPONSE_INVALID", "MODEL_BUDGET_EXCEEDED", "AGENT_LIMIT_REACHED", "ORIGIN_REJECTED", "DATABASE_ERROR"]),
  status: z.number().int().min(400).max(599),
  state: AgentStateSchema.nullable(),
  persistedChange: z.boolean(),
}).strict();
export type AgentTurnFailure = z.infer<typeof AgentTurnFailureSchema>;
type TurnMetadata = Pick<AgentTurnFailure, "state" | "persistedChange">;

/** Safe historical metadata, never a guarantee that terminal caching succeeded.
 * Null state means absent OR not safely verifiable; it is not a deletion signal. */
export class AgentTurnError extends AppError {
  readonly turn: Readonly<TurnMetadata>;
  constructor(input: AgentTurnFailure) {
    const failure = AgentTurnFailureSchema.parse(input);
    super(failure.code, failure.status, "Agent turn failed");
    this.turn = Object.freeze({ state: failure.state, persistedChange: failure.persistedChange });
  }
}

export function toAgentTurnError(error: unknown, context: TurnMetadata): AgentTurnError {
  const parsed = error instanceof AppError
    ? AgentTurnFailureSchema.safeParse({ code: error.code, status: error.status, ...context })
    : null;
  return new AgentTurnError(parsed?.success ? parsed.data : { code: "DATABASE_ERROR", status: 500, ...context });
}
