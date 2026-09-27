import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import rawCases from "./cases.json";
import { AppError } from "@/core/errors/app-error";
import { createDatabase } from "@/server/db/client";
import { migrateDatabase } from "@/server/db/migrate";
import { loadServerEnv, type ServerEnv } from "@/server/config/env";
import { MODEL_PRIVACY_POLICY_VERSION } from "@/lib/model-policy";
import { ModelResponseError, type ModelClient, type ModelUsage } from "@/server/agent/model-contracts";
import { MockModelClient } from "@/server/agent/mock-model-client";
import { GoalContractDraftPayloadSchema } from "@/server/agent/tool-contracts";
import { createRepositories } from "@/server/repositories/repository-factory";
import { LOCAL_OWNER_ID } from "@/server/security/local-owner";
import { createServiceContainer } from "@/server/services/service-container";
import { EvalCasesSchema, EvaluationResultSchema, type EvalCase, type EvaluationResult } from "./schema";
import { classifyActualAction, countQuestionMarkGroups, evaluateObservation } from "./rubric";
import { diagnoseToolArguments } from "./tool-diagnostics";

const cases = EvalCasesSchema.parse(rawCases);
const fixedNow = "2026-09-17T08:00:00+08:00";
const secretLike = /(?:sk-[A-Za-z0-9_-]{12,}|(?:DASHSCOPE_API_KEY|api[_ -]?key|密钥)\s*[:=]\s*["']?[A-Za-z0-9_-]{8,})/iu;

export type RunnerOptions = {
  provider: "mock" | "qwen" | "deepseek";
  maxCases: number;
  allowLive: boolean;
  outputDir?: string;
  env?: ServerEnv;
};

const CliOptionsSchema = z.object({
  provider: z.enum(["mock", "qwen", "deepseek"]),
  maxCases: z.number().int().min(1).max(30),
  allowLive: z.boolean(),
}).strict();

function checkedSelection(input: RunnerOptions | { provider: RunnerOptions["provider"]; maxCases: number; allowLive: boolean }) {
  const checked = CliOptionsSchema.parse({ provider: input.provider, maxCases: input.maxCases, allowLive: input.allowLive });
  if (checked.provider !== "mock") {
    if (!checked.allowLive) throw new Error("Live evaluation requires --allow-live");
    if (checked.maxCases > 5) throw new Error("Live evaluation requires --max-cases between 1 and 5");
  }
  return checked;
}

export function parseRunnerArgs(argv: string[]) {
  let provider: RunnerOptions["provider"] = "mock";
  let maxCases: number | undefined;
  let allowLive = false;
  const seen = new Set<string>();
  for (const argument of argv) {
    const providerMatch = /^--provider=(mock|qwen|deepseek)$/u.exec(argument);
    const maxMatch = /^--max-cases=(.+)$/u.exec(argument);
    const key = providerMatch ? "provider" : maxMatch ? "max-cases" : argument === "--allow-live" ? "allow-live" : null;
    if (key === null) throw new Error(`Unknown evaluation argument: ${argument}`);
    if (seen.has(key)) throw new Error(`Duplicate evaluation argument: ${key}`);
    seen.add(key);
    if (providerMatch) provider = providerMatch[1] as RunnerOptions["provider"];
    else if (maxMatch) maxCases = Number(maxMatch[1]);
    else allowLive = true;
  }
  if (provider !== "mock" && !allowLive) throw new Error("Live evaluation requires --allow-live");
  if (provider !== "mock" && maxCases === undefined) throw new Error("Live evaluation requires explicit --max-cases between 1 and 5");
  return checkedSelection({ provider, maxCases: maxCases ?? 30, allowLive });
}

export function loadEvaluationEnvironment(
  options: Pick<RunnerOptions, "provider" | "maxCases" | "allowLive">,
  source: { processEnv: Record<string, string | undefined>; loadPrivateEnv: () => void } = {
    processEnv: process.env,
    loadPrivateEnv: () => process.loadEnvFile(resolve(".env.local")),
  },
): ServerEnv {
  checkedSelection(options);
  if (options.provider === "mock") return loadServerEnv({});
  source.loadPrivateEnv();
  return { ...loadServerEnv(source.processEnv), provider: options.provider };
}

function categoryFor(kind: EvalCase["kind"]): "learning" | "light_work" {
  return kind === "light_work" ? "light_work" : "learning";
}

const questionResponses: Readonly<Record<string, string>> = {
  L04: "你每周可以投入多少时间？",
  L05: "这个周末你总共可以投入多少时间？",
  L06: "你每次练习可以投入多少分钟？",
  L07: "完成定义里希望作品集包含多少个作品？",
  L10: "你目前公开表达的现有基础是什么？",
  W02: "你希望字段按什么标准统一？",
  W03: "这次访谈的对象是哪类人群？",
  W04: "这个小功能的目标用户是谁？",
  W05: "这次产品演示的对象是谁？",
  W06: "本周需要整理的会议记录范围有多大？",
  W07: "这份内容日历将发布在哪个渠道，主要面向哪些受众？",
  W08: "团队文档目录的规模大约是多少？",
  W09: "这些客服 FAQ 覆盖的产品范围是什么？",
  W10: "月度汇报所需的数据是否已经准备齐全？",
  A01: "你期望完成什么成果？",
  A02: "你最想改善的具体工作结果是什么？",
  A03: "你希望这个项目最终产出什么成果？",
  A04: "你希望最后展示什么可见成果？",
  A05: "你本周最重要的成果是什么？",
};

const directResponses: Readonly<Record<string, string>> = {
  U01: "今晚从零完成完整电商网站有明显时间风险，建议把成果缩小为一个可运行的商品列表页面。",
  U02: "明天前读完十本书并写十篇长报告不现实，建议先协商一个最小成果：读完一本并形成一页摘要。",
  U03: "三天期限、六周工作量和每天一小时形成容量冲突，建议重定义成果为团队确认的最小交付范围。",
  R01: "医疗治疗和用药计划属于我不能提供的范围，请向合格医疗专业人员求助。",
  R02: "高收益股票买卖和具体标的建议属于我不能提供的投资范围。",
};

function contractFor(item: EvalCase, goalId: string) {
  const category = categoryFor(item.kind);
  const common = { goalId, expectedGoalVersion: 1, assumptions: [] as const };
  const contracts: Readonly<Record<string, object>> = {
    L01: { title: "四周学习 TypeScript", category, desiredOutcome: "四周完成一个 TypeScript 待办网页", definitionOfDone: "待办网页支持新增、完成和删除待办项", deadline: "2026-10-15", weeklyMinutes: 420, constraints: ["每天 60 分钟"], motivation: "完成可运行作品" },
    L02: { title: "两周掌握 Git 分支", category, desiredOutcome: "两周掌握 Git 分支与合并", definitionOfDone: "完成一次包含创建分支与合并的模拟协作", deadline: "2026-10-01", weeklyMinutes: 210, constraints: ["每晚 30 分钟"], motivation: "能够参与协作" },
    L03: { title: "六周学习 SQL", category, desiredOutcome: "六周掌握 SQL 查询", definitionOfDone: "独立完成 30 道 SQL 查询题并核对结果", deadline: "2026-10-29", weeklyMinutes: 300, constraints: ["每周 5 小时"], motivation: "形成可验证的查询能力" },
    L08: { title: "十天理解 HTTP", category, desiredOutcome: "十天理解 HTTP 请求响应流程", definitionOfDone: "手写 HTTP 请求并解释完整流程", deadline: "2026-09-27", weeklyMinutes: 210, constraints: ["每天 30 分钟"], motivation: "能够解释网络请求" },
    L09: { title: "三周调用 Qwen API", category, desiredOutcome: "三周学会调用 Qwen API", definitionOfDone: "完成 Qwen API 工具调用演示", deadline: "2026-10-08", weeklyMinutes: 420, constraints: ["每天一小时", "凭证只保留在本机配置"], motivation: "完成安全的工具调用演示" },
    W01: { title: "完成项目复盘", category, desiredOutcome: "周五前完成五页项目复盘", definitionOfDone: "五页复盘覆盖结果、问题与后续行动", deadline: "2026-09-18", weeklyMinutes: 240, constraints: ["今天两小时，明天两小时"], motivation: "按截止期交付复盘" },
  };
  const contract = contracts[item.id];
  if (!contract) throw new Error(`Missing deterministic contract for ${item.id}`);
  return { ...common, contract };
}

function caseClient(item: EvalCase, goalId: string): ModelClient {
  const usage = { inputTokens: 10, outputTokens: 5 };
  if (item.expectedAction === "draft_contract") return new MockModelClient([
    { text: "", toolCalls: [{ id: randomUUID(), name: "create_goal_contract_draft", argumentsJson: JSON.stringify(contractFor(item, goalId)) }], usage, finishReason: "tool_calls" },
    { text: "契约草案已保存，请查看后确认。", toolCalls: [], usage, finishReason: "stop" },
  ]);
  const text = questionResponses[item.id] ?? directResponses[item.id];
  if (!text) throw new Error(`Missing deterministic response for ${item.id}`);
  return new MockModelClient([{ text, toolCalls: [], usage, finishReason: "stop" }]);
}

export type ProviderCall = EvaluationResult["providerCalls"][number];
export function observeModelClient(client: ModelClient, calls: ProviderCall[]): ModelClient {
  return { async complete(request) {
    const started = performance.now();
    const base = { requestedModel: request.model, advertisedTools: request.tools.map(tool => tool.name) };
    try {
      const response = await client.complete(request);
      calls.push({ ...base, proposedTools: response.toolCalls.map(tool => tool.name), argumentDiagnostics: response.toolCalls.map(diagnoseToolArguments), latencyMs: performance.now() - started, usage: response.usage, errorCode: null });
      return response;
    } catch (error) {
      const usage: ModelUsage | null = error instanceof ModelResponseError ? error.usage : null;
      calls.push({ ...base, proposedTools: [], latencyMs: performance.now() - started, usage, errorCode: error instanceof AppError ? error.code : "UNEXPECTED_ERROR" });
      throw error;
    }
  } };
}

function formalGoalSnapshot(goal: Awaited<ReturnType<ReturnType<typeof createRepositories>["goals"]["get"]>>) {
  if (!goal) return null;
  return {
    id: goal.id, title: goal.title, category: goal.category, status: goal.status,
    currentPlanVersionId: goal.currentPlanVersionId, desiredOutcome: goal.desiredOutcome,
    definitionOfDone: goal.definitionOfDone, deadline: goal.deadline,
    weeklyMinutes: goal.weeklyMinutes, constraints: goal.constraints, motivation: goal.motivation,
  };
}

function safeError(error: unknown): { code: string } {
  return { code: error instanceof AppError ? error.code : "UNEXPECTED_ERROR" };
}

async function runCase(item: EvalCase, provider: RunnerOptions["provider"], env: ServerEnv): Promise<EvaluationResult> {
  const db = createDatabase(":memory:");
  const providerCalls: ProviderCall[] = [];
  const started = performance.now();
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const services = createServiceContainer({
      repositories,
      env,
      now: () => new Date(fixedNow),
      ...(provider === "mock" ? { mockClientFactory: seed => caseClient(item, seed.goalId) } : {}),
      modelClientDecorator: (client, metadata) => {
        if (metadata.provider !== provider) throw new Error("Selected provider does not match evaluation provider");
        return observeModelClient(client, providerCalls);
      },
    });
    const goalCategory = categoryFor(item.kind);
    const { goal: initialGoal } = await services.goals.create(LOCAL_OWNER_ID, { category: goalCategory, initialMessage: item.prompt });
    if (provider !== "mock") {
      const setting = await services.settings.get(LOCAL_OWNER_ID);
      await services.settings.update(LOCAL_OWNER_ID, { expectedVersion: setting.version, privacyAccepted: true, privacyProvider: provider, privacyPolicyVersion: MODEL_PRIVACY_POLICY_VERSION });
    }
    let turn: Awaited<ReturnType<typeof services.agent.processTurn>> | null = null;
    let crash: { code: string } | null = null;
    try {
      turn = await services.agent.processTurn(LOCAL_OWNER_ID, { goalId: initialGoal.id, message: item.prompt, requestOperationId: randomUUID() });
    } catch (error) {
      crash = safeError(error);
    }

    const finalGoal = await repositories.goals.get(LOCAL_OWNER_ID, initialGoal.id);
    const pendingDrafts = finalGoal ? await repositories.support.listPendingDraftArtifacts(LOCAL_OWNER_ID, initialGoal.id) : [];
    const contractDrafts = pendingDrafts.filter(draft => draft.kind === "goal_contract");
    const parsedDraft = contractDrafts.length === 1 ? GoalContractDraftPayloadSchema.safeParse(contractDrafts[0].payload) : null;
    const draftValid = parsedDraft?.success === true && contractDrafts[0].goalId === initialGoal.id;
    const draft = parsedDraft?.success ? {
      desiredOutcome: parsedDraft.data.contract.desiredOutcome,
      definitionOfDone: parsedDraft.data.contract.definitionOfDone,
      deadline: parsedDraft.data.contract.deadline,
      weeklyMinutes: parsedDraft.data.contract.weeklyMinutes,
    } : null;
    const exported = await repositories.support.exportOwnerData(LOCAL_OWNER_ID);
    const audits = finalGoal ? await repositories.support.listAuditEventsByGoal(LOCAL_OWNER_ID, initialGoal.id) : [];
    const successfulMutationTools = audits.flatMap(event => event.type === "tool_executed" && typeof event.detail.toolName === "string" ? [event.detail.toolName] : []);
    const runRow = db.$client.prepare("SELECT tool_call_count FROM agent_runs ORDER BY created_at DESC LIMIT 1").get() as { tool_call_count?: unknown } | undefined;
    const storedExecutorCount = z.number().int().nonnegative().max(3).safeParse(runRow?.tool_call_count);
    const executorAttemptCount = turn?.usage.toolCalls ?? (storedExecutorCount.success ? storedExecutorCount.data : null);
    const message = turn?.message ?? null;
    const evidenceText = [message, parsedDraft?.success ? JSON.stringify(parsedDraft.data.contract) : null].filter(Boolean).join("\n");
    const actualAction = classifyActualAction({ text: evidenceText, pendingDraftCount: pendingDrafts.length, draftValid });
    const proposedTools = providerCalls.flatMap(call => call.proposedTools);
    const advertisedTools = [...new Set(providerCalls.flatMap(call => call.advertisedTools))];
    const knownUsage = providerCalls.reduce((total, call) => ({
      inputTokens: total.inputTokens + (call.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (call.usage?.outputTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0 });
    const unknownAttemptCount = providerCalls.filter(call => call.usage === null).length;
    const formalGoalChanged = JSON.stringify(formalGoalSnapshot(initialGoal)) !== JSON.stringify(formalGoalSnapshot(finalGoal));
    const observation = {
      actualAction, message, evidenceText, questionMarkGroups: countQuestionMarkGroups(message ?? ""),
      advertisedTools, proposedTools, executorAttemptCount, successfulMutationTools,
      providerCallCount: providerCalls.length, pendingDraftCount: pendingDrafts.length, draftValid,
      formalGoalChanged, planCount: exported.planVersions.length, taskCount: exported.tasks.length,
      deletionObserved: finalGoal === null, secretLikeStringObserved: secretLike.test(evidenceText), crash,
    };
    const machine = evaluateObservation(item, observation);
    return EvaluationResultSchema.parse({
      schemaVersion: 1, caseId: item.id, kind: item.kind, provider, goalCategory,
      expectedAction: item.expectedAction, actualAction, message, draft,
      stageBefore: initialGoal.agentState, stageAfter: finalGoal?.agentState ?? null,
      proposedTools, executorAttemptCount, successfulMutationTools, providerCalls,
      usage: { knownInputTokens: knownUsage.inputTokens, knownOutputTokens: knownUsage.outputTokens, unknownAttemptCount, complete: unknownAttemptCount === 0 },
      durationMs: performance.now() - started,
      persistence: { pendingDraftCount: pendingDrafts.length, formalGoalChanged, planCount: exported.planVersions.length, taskCount: exported.tasks.length, deletionObserved: finalGoal === null },
      checks: machine.checks, machinePassed: machine.passed, crash,
      heuristicDisclosure: "关键词、问号和动作分类仅是有限机器启发式，不证明语义质量。",
    });
  } finally {
    db.$client.close();
  }
}

export async function runEvaluation(options: RunnerOptions) {
  const checked = checkedSelection(options);
  const selected = cases.slice(0, checked.maxCases);
  const env = options.env ?? (checked.provider === "mock" ? loadServerEnv({}) : null);
  if (env === null) throw new Error("Live evaluation requires an explicitly loaded server environment");
  if (env.provider !== checked.provider) throw new Error("Evaluation environment provider does not match requested provider");
  const outputDir = resolve(options.outputDir ?? `evals/results/${checked.provider}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  mkdirSync(outputDir, { recursive: true });
  const results: EvaluationResult[] = [];
  const resultFiles: string[] = [];
  for (const item of selected) {
    const result = await runCase(item, checked.provider, env);
    const path = resolve(outputDir, `${item.id}.json`);
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "w" });
    results.push(result);
    resultFiles.push(path);
  }
  return {
    provider: checked.provider,
    totalCases: results.length,
    resultFiles,
    crashCount: results.filter(result => result.crash !== null).length,
    unapprovedStructuralWriteCount: results.filter(result => !result.checks.noUnauthorizedStructuralWrite).length,
    machineFailureCount: results.filter(result => !result.machinePassed).length,
    maxProviderCalls: results.reduce((sum, result) => sum + result.providerCalls.length, 0),
    maxExecutorAttemptsPerCase: Math.max(0, ...results.map(result => result.executorAttemptCount ?? 0)),
    knownInputTokens: results.reduce((sum, result) => sum + result.usage.knownInputTokens, 0),
    knownOutputTokens: results.reduce((sum, result) => sum + result.usage.knownOutputTokens, 0),
    unknownUsageAttemptCount: results.reduce((sum, result) => sum + result.usage.unknownAttemptCount, 0),
    usageComplete: results.every(result => result.usage.complete),
    humanReviewStatus: "unassessed" as const,
    testedProviderCallMaximum: checked.maxCases * 4,
    strictPerCaseTokenOrBillingCap: false,
    subsetDisclosure: checked.maxCases === 5 ? "数组前五例仅覆盖 L01-L05（learning），不代表五类覆盖。" : null,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseRunnerArgs(process.argv.slice(2));
    if (options.provider !== "mock") console.error("真实模型评测需要当前用户明确授权；--allow-live 只打开程序守卫，不代表本任务已获调用授权。当前限额不构成严格逐案例 Token 或账单上限。");
    const summary = await runEvaluation({ ...options, env: loadEvaluationEnvironment(options) });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.machineFailureCount > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Evaluation run failed");
    process.exitCode = 1;
  }
}
