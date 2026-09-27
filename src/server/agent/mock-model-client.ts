import { AppError } from "@/core/errors/app-error";
import { ModelRequestSchema, ModelTurnSchema, type ModelClient, type ModelRequest, type ModelTurn } from "./model-contracts";

export class MockModelClient implements ModelClient {
  private readonly turns: ModelTurn[];
  constructor(turns: readonly ModelTurn[]) { this.turns = turns.map(turn => ModelTurnSchema.parse(turn)); }
  async complete(request: ModelRequest): Promise<ModelTurn> {
    ModelRequestSchema.parse(request);
    const turn = this.turns.shift();
    if (!turn) throw new AppError("MODEL_RESPONSE_INVALID", 502, "Mock model queue exhausted");
    return turn;
  }
}
