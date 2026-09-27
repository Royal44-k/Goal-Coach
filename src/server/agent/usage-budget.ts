import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { loadAuthConfig } from "../auth/auth-config";
import type { AppSetting } from "@/core/domain/contracts";
import type { RepositoryUnitOfWork, TransactionRepositories } from "../repositories/repository-types";
import { ModelUsageReceiptSchema, parseModelUsageReceipt } from "../repositories/model-usage-receipt";
import { contentHash } from "../security/canonical-json";
import { ModelRequestSchema, ModelUsageSchema, type ModelRequest, type ModelUsage } from "./model-contracts";

export const ModelAdmissionSchema = z.object({
  ownerId: z.uuid(), attemptId: z.uuid(), day: z.iso.date(), settingId: z.uuid(), runId: z.uuid().nullable(),
}).strict();
export type ModelAdmission = z.infer<typeof ModelAdmissionSchema>;
export type ModelDispatchCheck = { status: "ready"; admission: ModelAdmission }
  | { status: "cancelled"; reason: "workspace_cleared" | "run_deleted" };
export type ModelSettlement = { status: "settled"; duplicate: boolean; runUpdated: boolean }
  | { status: "cancelled"; reason: "workspace_cleared" };
const shanghaiDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

/** Local guard only: unknown timeout/crash counts and concurrent calls are not reserved. */
export class UsageBudgetService {
  private readonly now: () => Date;
  constructor(private readonly repositories: RepositoryUnitOfWork, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }
  async assertCanCall(ownerId: string, request: ModelRequest, runId?: string): Promise<ModelAdmission> {
    z.uuid().parse(ownerId); if (runId !== undefined) z.uuid().parse(runId);
    ModelRequestSchema.parse(request);
    return this.repositories.withTransaction(tx => {
      const setting = tx.support.getSettingsByOwner(ownerId);
      if (!setting) throw new AppError("MODEL_CONFIG_MISSING", 503, "Initialize application settings before model admission");
      if (runId && !tx.support.getAgentRun(ownerId, runId)) throw new AppError("NOT_FOUND", 404, "Model run does not exist for this owner");
      const day = this.day(); this.check(tx, ownerId, setting, day, request);
      return { ownerId, attemptId: randomUUID(), day, settingId: setting.id, runId: runId ?? null };
    });
  }
  /** Call after async preparation, immediately before dispatch; pass this returned admission to settle. */
  async recheckBeforeDispatch(input: ModelAdmission, request: ModelRequest): Promise<ModelDispatchCheck> {
    const admission = ModelAdmissionSchema.parse(input); ModelRequestSchema.parse(request);
    return this.repositories.withTransaction<ModelDispatchCheck>(tx => {
      const setting = tx.support.getSettingsByOwner(admission.ownerId);
      if (!setting || setting.id !== admission.settingId) return { status: "cancelled", reason: "workspace_cleared" };
      if (admission.runId && !tx.support.getAgentRun(admission.ownerId, admission.runId)) return { status: "cancelled", reason: "run_deleted" };
      const day = this.day(); this.check(tx, admission.ownerId, setting, day, request);
      return { status: "ready", admission: { ...admission, day } };
    });
  }
  /** Settle every known returned count before any subsequent call, including counts on ModelResponseError. */
  async settle(input: ModelAdmission, usageInput: ModelUsage): Promise<ModelSettlement> {
    const admission = ModelAdmissionSchema.parse(input); const usage = ModelUsageSchema.parse(usageInput);
    return this.repositories.withTransaction<ModelSettlement>(tx => {
      const receipt = ModelUsageReceiptSchema.parse({ schemaVersion: 1, kind: "model_usage",
        attemptId: admission.attemptId, day: admission.day, ...usage });
      if (loadAuthConfig().mode === "invite") tx.support.retainAccountModelUsage(admission.ownerId, receipt);
      const setting = tx.support.getSettingsByOwner(admission.ownerId);
      if (!setting || setting.id !== admission.settingId) return { status: "cancelled", reason: "workspace_cleared" };
      const parameterHash = contentHash(receipt); const operationId = `model-usage:${admission.attemptId}`;
      const existing = tx.support.getOperationByOperationId(admission.ownerId, operationId);
      if (existing) {
        const stored = parseModelUsageReceipt(existing);
        if (contentHash(stored) !== parameterHash) throw new AppError("VALIDATION_ERROR", 400, "Model attempt already has different usage metadata");
        return { status: "settled", duplicate: true, runUpdated: false };
      }
      const operation = tx.support.createOperation(admission.ownerId, { goalId: null, operationId, toolName: "record_model_usage", parameterHash });
      tx.support.updateOperation(admission.ownerId, operation.id, operation.version, { status: "succeeded", result: receipt });
      const run = admission.runId ? tx.support.getAgentRun(admission.ownerId, admission.runId) : null;
      if (run) {
        const counters = ModelUsageSchema.parse({ inputTokens: run.inputTokenCount + usage.inputTokens, outputTokens: run.outputTokenCount + usage.outputTokens });
        tx.support.updateAgentRun(admission.ownerId, run.id, run.version, { inputTokenCount: counters.inputTokens, outputTokenCount: counters.outputTokens });
      }
      return { status: "settled", duplicate: false, runUpdated: run !== null };
    });
  }
  private day(): string { return z.iso.date().parse(shanghaiDay.format(this.now())); }
  private check(tx: TransactionRepositories, ownerId: string, setting: AppSetting, day: string, request: ModelRequest): void {
    const receipts = loadAuthConfig().mode === "invite" ? tx.support.listAccountModelUsage(ownerId, day) : tx.support.listModelUsageReceipts(ownerId, day);
    const totals = receipts.reduce((sum, receipt) => ({ inputTokens: sum.inputTokens + receipt.inputTokens, outputTokens: sum.outputTokens + receipt.outputTokens }), { inputTokens: 0, outputTokens: 0 });
    const estimatedInput = Buffer.byteLength(JSON.stringify(request), "utf8");
    if (!Number.isSafeInteger(totals.inputTokens + estimatedInput) || !Number.isSafeInteger(totals.outputTokens)
      || totals.inputTokens + estimatedInput > setting.dailyInputTokenLimit || totals.outputTokens >= setting.dailyOutputTokenLimit)
      throw new AppError("MODEL_BUDGET_EXCEEDED", 429, "Local daily model usage budget exceeded");
  }
}
