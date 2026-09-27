import { JsonObjectSchema, type AuditEvent, type JsonValue } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type { SupportRepository, SyncRepository } from "../repositories/repository-types";
import { redactSensitive } from "../security/redact";

export type AuditRecordInput = {
  ownerId: string;
  goalId: string | null;
  type: string;
  entityType: string;
  entityId: string;
  detail: Record<string, JsonValue>;
};

function prepare(input: AuditRecordInput) {
  const detail = JsonObjectSchema.safeParse(redactSensitive(input.detail));
  if (!detail.success) {
    throw new AppError("VALIDATION_ERROR", 400, "Audit detail is not JSON-safe");
  }
  return {
    goalId: input.goalId,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    detail: detail.data,
  };
}

export class AuditService {
  constructor(private readonly support: SupportRepository) {}

  async record(input: AuditRecordInput): Promise<AuditEvent> {
    return this.support.createAuditEvent(input.ownerId, prepare(input));
  }

  recordInTransaction(
    support: SyncRepository<SupportRepository>,
    input: AuditRecordInput,
  ): AuditEvent {
    return support.createAuditEvent(input.ownerId, prepare(input));
  }
}
