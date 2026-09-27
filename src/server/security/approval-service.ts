import { ZodError } from "zod";
import type { ApprovalGrant } from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import type { SupportRepository, SyncRepository } from "../repositories/repository-types";
import { contentHash } from "./canonical-json";

export type ApprovalBinding = {
  ownerId: string;
  subjectId: string;
  toolName: string;
  payload: unknown;
};

export type ApprovalConsumption = ApprovalBinding & { grantId: string };

function invalidApproval(): never {
  throw new AppError("APPROVAL_INVALID", 403, "Approval binding, lifetime, or use state is invalid");
}

function issueValues(input: ApprovalBinding, now: Date) {
  return {
    subjectId: input.subjectId,
    allowedTool: input.toolName,
    contentHash: contentHash(input.payload),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1_000).toISOString(),
  };
}

function consumeBound(
  support: SyncRepository<SupportRepository>,
  input: ApprovalConsumption,
  now: string,
): ApprovalGrant {
  const grant = support.getApprovalGrant(input.ownerId, input.grantId);
  if (!grant) invalidApproval();
  const consumed = support.consumeApprovalGrant(input.ownerId, {
    grantId: input.grantId,
    subjectId: input.subjectId,
    allowedTool: input.toolName,
    contentHash: contentHash(input.payload),
    now,
    expectedVersion: grant.version,
  });
  return consumed ?? invalidApproval();
}

export class ApprovalService {
  constructor(
    private readonly support: SupportRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: ApprovalBinding): Promise<ApprovalGrant> {
    return this.support.createApprovalGrant(input.ownerId, issueValues(input, this.now()));
  }

  issueInTransaction(
    support: SyncRepository<SupportRepository>,
    input: ApprovalBinding,
  ): ApprovalGrant {
    return support.createApprovalGrant(input.ownerId, issueValues(input, this.now()));
  }

  async consume(input: ApprovalConsumption): Promise<ApprovalGrant> {
    try {
      const grant = await this.support.getApprovalGrant(input.ownerId, input.grantId);
      if (!grant) invalidApproval();
      const consumed = await this.support.consumeApprovalGrant(input.ownerId, {
        grantId: input.grantId,
        subjectId: input.subjectId,
        allowedTool: input.toolName,
        contentHash: contentHash(input.payload),
        now: this.now().toISOString(),
        expectedVersion: grant.version,
      });
      return consumed ?? invalidApproval();
    }
    catch (error) {
      if (error instanceof AppError && error.code === "APPROVAL_INVALID") throw error;
      if (error instanceof ZodError || (error instanceof AppError && error.code === "VALIDATION_ERROR")) {
        invalidApproval();
      }
      throw error;
    }
  }

  consumeInTransaction(
    support: SyncRepository<SupportRepository>,
    input: ApprovalConsumption,
  ): ApprovalGrant {
    try {
      return consumeBound(support, input, this.now().toISOString());
    }
    catch (error) {
      if (error instanceof AppError && error.code === "APPROVAL_INVALID") throw error;
      if (error instanceof ZodError || (error instanceof AppError && error.code === "VALIDATION_ERROR")) {
        invalidApproval();
      }
      throw error;
    }
  }
}
