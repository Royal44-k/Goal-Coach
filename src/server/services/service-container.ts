import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import type { Repositories, RepositoryUnitOfWork } from "../repositories/repository-types";
import { loadServerEnv, type ServerEnv } from "../config/env";
import { AgentOrchestrator } from "../agent/orchestrator";
import { UsageBudgetService } from "../agent/usage-budget";
import { QwenClient } from "../agent/qwen-client";
import { DeepSeekClient } from "../agent/deepseek-client";
import type { ModelClient } from "../agent/model-contracts";
import { LocalMockModelClient, type TurnModelSeed } from "../agent/local-mock-model-client";
import { ToolExecutor } from "../agent/tool-executor";
import { ApprovalService } from "../security/approval-service";
import { OperationService } from "../operations/operation-service";
import { UndoService } from "../operations/undo-service";
import { AuditService } from "../audit/audit-service";
import { PlanRevisionEnvelopeSchema } from "../repositories/revision-contracts";
import { GoalService } from "./goal-service";
import { PlanService } from "./plan-service";
import { TaskService } from "./task-service";
import { ApprovalUseCase } from "./approval-use-case";
import { DataService } from "./data-service";
import { SettingsService } from "./settings-service";
import { createToolHandlers } from "./tool-handlers";
import { approvalReviewers } from "./approval-reviewers";
import { AgentInputSchema } from "./service-contracts";
import { planningProjection } from "./workspace-projection";
import { loadAuthConfig } from "../auth/auth-config";
import { acquireAgentLease, dailyAgentTurnLimit } from "../agent/admission-limits";
import { AppError } from "@/core/errors/app-error";
import { hasCurrentModelConsent } from "@/lib/model-policy";
import { resolveEffectiveModelPolicy } from "../config/effective-model-policy";

export type ServiceContainerOptions = {
  repositories: Repositories & RepositoryUnitOfWork;
  env: ServerEnv;
  now?: () => Date;
  mockClientFactory?: (seed: TurnModelSeed) => ModelClient;
  modelClientDecorator?: (client: ModelClient, context: { provider: "mock" | "qwen" | "deepseek"; seed: TurnModelSeed }) => ModelClient;
};
export function createServiceContainer(options: ServiceContainerOptions) {
  const r = options.repositories, now = options.now ?? (() => new Date());
  const operations = new OperationService(r), undo = new UndoService(r, now);
  const tools = new ToolExecutor({ repositories: r, operations, undo, audit: new AuditService(r.support), approvals: new ApprovalService(r.support, now), approvalReviewers, handlers: createToolHandlers(options.env, now), now });
  const settings = new SettingsService(r, options.env, now);
  return {
    goals: new GoalService(r, operations, tools, now), plans: new PlanService(operations), tasks: new TaskService(tools, operations, undo), approvals: new ApprovalUseCase(tools), data: new DataService(r, tools, now), settings,
    agent: { async processTurn(ownerId: string, raw: unknown) {
      const input = AgentInputSchema.parse(raw);
      if (!await r.goals.get(ownerId, input.goalId)) throw new AppError("NOT_FOUND", 404, "Goal is unavailable");
      const setting = await settings.get(ownerId);
      const invite = loadAuthConfig().mode === "invite";
      const dailyTurnLimit = invite ? dailyAgentTurnLimit() : undefined;
      const existing = await r.support.getOperationByOperationId(ownerId, `agent-turn:${input.requestOperationId}`);
      if (!existing && setting.provider !== "mock" && !hasCurrentModelConsent(setting)) throw new AppError("APPROVAL_REQUIRED", 403, "Current provider privacy consent is required before admission");
      const policy = { ...resolveEffectiveModelPolicy(options.env, setting.provider), fallbackEnabled: setting.provider === "qwen" && setting.fallbackEnabled };
      const release = invite && !existing ? acquireAgentLease(ownerId) : () => undefined;
      try {
      const seed = { ownerId, goalId: input.goalId, userMessage: input.message };
      let underlying: ModelClient | undefined;
      const model: ModelClient = { async complete(request) {
        if (setting.provider !== "mock") {
          const current = await settings.get(ownerId);
          if (current.provider !== setting.provider || !hasCurrentModelConsent(current)) throw new AppError("APPROVAL_REQUIRED", 403, "Current provider privacy consent is required before dispatch");
        }
        // Provider is fixed for this explicit turn. Neither replay nor pending admission reaches this factory.
        if (!underlying) {
          const selected = setting.provider === "deepseek" ? new DeepSeekClient(options.env.deepseek) : setting.provider === "qwen" ? new QwenClient(options.env) : options.mockClientFactory?.(seed) ?? new LocalMockModelClient(seed, () => r.withTransaction(tx => {
            const goal = tx.goals.get(ownerId, input.goalId);
            const plan = goal ? tx.plans.getCurrent(ownerId, goal.id) : null;
            const tasks = plan ? tx.tasks.listByGoal(ownerId, input.goalId, plan.id) : [];
            return { goal, tasks, checkIns: goal ? planningProjection(tx, ownerId, goal.id).projectedCheckIns : [], evidence: tasks.flatMap(t => tx.support.listEvidenceByTask(ownerId, t.id)), ...(plan ? { milestones: PlanRevisionEnvelopeSchema.parse(plan.diff).revision.payload.milestones } : {}) };
          }));
          underlying = options.modelClientDecorator?.(selected, { provider: setting.provider, seed }) ?? selected;
        }
        return underlying.complete(request);
      } };
      return await new AgentOrchestrator({ repositories: r, model, budget: new UsageBudgetService(r, { now }), tools, now, dailyTurnLimit, policy }).processTurn({ ownerId, goalId: input.goalId, userMessage: input.message, requestOperationId: input.requestOperationId, explicitIntent: input.explicitIntent });
      } finally { release(); }
    } },
  };
}
export type ServiceContainer = ReturnType<typeof createServiceContainer>;
let container: ServiceContainer | undefined;
export function getServiceContainer(): ServiceContainer {
  if (!container) {
    const env = loadServerEnv();
    const db = createDatabase(env.databasePath);
    migrateDatabase(db);
    container = createServiceContainer({ repositories: createRepositories(db), env });
  }
  return container;
}
