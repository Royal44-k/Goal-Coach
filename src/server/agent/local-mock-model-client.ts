import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CheckInSchema, GoalSchema, TaskEvidenceSchema, TaskSchema } from "@/core/domain/contracts";
import { ModelRequestSchema, ModelTurnSchema, type ModelClient, type ModelRequest, type ModelTurn } from "./model-contracts";
import { modelToolArgsSchema, toolRegistry, type ModelToolName } from "./tool-registry";
import { PlanMilestonesSchema, TaskCreateInputSchema } from "../repositories/revision-contracts";

export type TurnModelSeed = { ownerId: string; goalId: string; userMessage: string };
const SnapshotSchema = z.object({ goal: GoalSchema.nullable(), tasks: z.array(TaskSchema), checkIns: z.array(CheckInSchema), evidence: z.array(TaskEvidenceSchema), milestones: PlanMilestonesSchema.optional() }).strict();
export type LocalMockSnapshot = z.infer<typeof SnapshotSchema>;
export const LOCAL_TYPESCRIPT_INPUT = "四周内学会 TypeScript，每天一小时，做一个待办网页";
export const LOCAL_TYPESCRIPT_DONE = "待办网页可以新增、勾选完成和删除任务，刷新后仍保留记录。";
const outcome = "学会 TypeScript，做一个待办网页";
const connection = "当前未连接模型，对话使用预设流程。";
const summarySystem = "你只负责压缩可见对话。仅保留用户决定、约束、未解决问题和用户可见结果；不要添加建议、秘密、工具协议或隐藏思维过程。摘要不超过1500个字符。";
const SummaryInputSchema = z.object({ existingSummary: z.string().trim().min(1).optional(), messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1) }).strict()).min(1) }).strict();

/** A finite, disclosed local script. No persistent sequence map and no writes. */
export class LocalMockModelClient implements ModelClient {
  private pending: { id: string; name: ModelToolName } | null = null;
  constructor(private readonly seed: TurnModelSeed, private readonly readSnapshot: () => Promise<LocalMockSnapshot>) {}
  private text(text: string): ModelTurn { return ModelTurnSchema.parse({ text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" }); }
  async complete(raw: ModelRequest): Promise<ModelTurn> {
    const request = ModelRequestSchema.parse(raw);
    if (request.tools.length === 0 && request.messages.length === 2 && request.messages[0].role === "system" && request.messages[0].content === summarySystem && request.messages[1].role === "user") {
      try {
        const input = SummaryInputSchema.parse(JSON.parse(request.messages[1].content));
        return this.text([input.existingSummary ?? "", ...input.messages.map(m => `${m.role === "user" ? "用户" : "回复"}：${m.content}`)].filter(Boolean).join("\n").slice(0, 1500));
      } catch { return this.text("当前预设流程无法压缩这份输入。"); }
    }
    if (this.pending) {
      const pending = this.pending;
      const result = request.messages.findLast(m => m.role === "tool" && m.toolCallId === pending.id);
      if (result?.role === "tool") {
        try {
          const parsed = toolRegistry[pending.name].resultSchema.parse(JSON.parse(result.content));
          this.pending = null;
          if ("draft" in parsed) return this.text("草案已保存，请查看内容与暂定值并在界面确认。" + connection);
          if ("advice" in parsed) return this.text(parsed.advice.minimumNextStep + " " + parsed.advice.explanation + " " + connection);
        } catch { /* An emitted call or malformed/repair response is never evidence of saving. */ }
      }
      return this.text("尚未获得成功保存的结果，请刷新查看当前状态。" + connection);
    }
    const snapshot = SnapshotSchema.parse(await this.readSnapshot());
    const goal = snapshot.goal;
    const message = this.seed.userMessage.trim();
    const call = (name: ModelToolName, args: unknown): ModelTurn => {
      if (!request.tools.some(t => t.name === name)) return this.text("当前状态无法执行这段预设流程。" + connection);
      const parsed = modelToolArgsSchema(name).parse(args);
      const id = randomUUID(); this.pending = { id, name };
      return ModelTurnSchema.parse({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(parsed) }], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "tool_calls" });
    };
    if (!goal || goal.ownerId !== this.seed.ownerId || goal.id !== this.seed.goalId) return this.text(connection + "这段预设流程无法自动理解当前目标。");
    const fixture = goal.title === LOCAL_TYPESCRIPT_INPUT || (goal.desiredOutcome === outcome && goal.definitionOfDone === LOCAL_TYPESCRIPT_DONE);
    if ((goal.agentState === "intake" || goal.agentState === "clarifying") && message === LOCAL_TYPESCRIPT_INPUT)
      return this.text(connection + "为了形成可核对的完成标准，待办网页需要具备哪些功能？");
    if (fixture && (goal.agentState === "intake" || goal.agentState === "clarifying" || goal.agentState === "contract_review") && message === LOCAL_TYPESCRIPT_DONE)
      return call("create_goal_contract_draft", { goalId: goal.id, expectedGoalVersion: goal.version, contract: { title: goal.title, category: goal.category, desiredOutcome: outcome, definitionOfDone: LOCAL_TYPESCRIPT_DONE, deadline: null, weeklyMinutes: 420, constraints: null, motivation: null }, assumptions: [] });
    const compatible = fixture && goal.desiredOutcome === outcome && goal.definitionOfDone === LOCAL_TYPESCRIPT_DONE && goal.weeklyMinutes === 420 && goal.deadline !== null && goal.constraints?.length === 0;
    if (goal.agentState === "planning" && compatible) {
      const keys = [randomUUID(), randomUUID(), randomUUID()];
      const tasks = [
        { id: keys[0], title: "练习 TypeScript 基础类型", action: "创建 TypeScript 文件，练习字符串、数字、布尔与 Todo 接口。", doneCriteria: "代码通过类型检查，并能说明 Todo 的字段类型。", dependencyIds: [] },
        { id: keys[1], title: "实现待办列表交互", action: "用 Todo 类型实现新增、勾选完成和删除任务。", doneCriteria: "在网页逐一验证新增、完成和删除操作。", dependencyIds: [keys[0]] },
        { id: keys[2], title: "保存并验证待办记录", action: "使用本地存储保存列表，刷新网页并验证记录。", doneCriteria: "刷新后任务内容与完成状态保持不变，并写下验证结果。", dependencyIds: [keys[1]] },
      ].map(t => ({ ...t, evidenceType: "text" as const, estimateMinutes: 60, dueAt: goal.deadline }));
      return call("create_plan_draft", { goalId: goal.id, payload: { base: { goalVersion: goal.version, planVersionId: goal.currentPlanVersionId }, tasks,
        milestones: ["掌握 TypeScript 基础类型", "完成待办网页交互", "验证刷新后的记录保留"], changeReason: null } });
    }
    if (fixture && message === "我卡住了，请帮我分析。") {
      const checkIn = snapshot.checkIns.filter(c => c.kind === "blocker").at(-1);
      if (checkIn?.blockerCategory) return call("diagnose_blocker", { goalId: goal.id, taskId: checkIn.taskId, blockerCategory: checkIn.blockerCategory, note: checkIn.note, advice: { minimumNextStep: "先用 5 分钟打开当前任务，写下一个尚未解决的小问题。", explanation: "这是根据已记录阻碍提供的预设小步骤，尚未改变计划。" } });
      return this.text("先在界面记录阻碍类别，预设流程才能读取这项反馈。" + connection);
    }
    if (compatible && ["请根据最新反馈调整计划。", "请重新提出调整方案。"].includes(message) && snapshot.milestones) {
      if (snapshot.tasks.length >= 8) return this.text("当前计划已有八项任务，无法再拆出独立起步任务；未保存调整草案。" + connection);
      const starterByTitle: Record<string, { title: string; action: string; doneCriteria: string; remainingAction: string }> = {
        "练习 TypeScript 基础类型": {
          title: "编写并检查 Todo 接口样例",
          action: "编写含 Todo 接口及一条类型化示例的 TypeScript 文件，运行类型检查并记录结果。",
          doneCriteria: "提交 Todo 接口样例与类型检查结果。",
          remainingAction: "沿用起步任务的 Todo 接口样例，继续练习字符串、数字、布尔类型，完成原定 TypeScript 基础类型练习。",
        },
        "实现待办列表交互": {
          title: "实现并验证新增待办",
          action: "沿用 Todo 类型实现新增一条待办，并在网页验证它出现在列表中。",
          doneCriteria: "网页可新增一条 Todo 待办，记录验证结果。",
          remainingAction: "沿用起步任务的新增待办结果，继续实现勾选完成和删除，验证三项交互。",
        },
        "保存并验证待办记录": {
          title: "保存并读取一条待办样例",
          action: "使用本地存储保存一条 Todo 待办，刷新后读取并记录结果。",
          doneCriteria: "刷新后能读取该待办样例，记录验证结果。",
          remainingAction: "沿用起步任务的存取样例，保存完整列表并验证刷新后内容和完成状态保持不变。",
        },
      };
      const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
      const completedAncestors = new Set<string>();
      const protect = (id: string): void => {
        if (completedAncestors.has(id)) return;
        completedAncestors.add(id);
        for (const dependencyId of byId.get(id)?.dependencyIds ?? []) protect(dependencyId);
      };
      for (const task of snapshot.tasks) if (task.status === "done") protect(task.id);
      const target = snapshot.tasks.find(task => task.status !== "done" && task.status !== "skipped" && !completedAncestors.has(task.id) && task.estimateMinutes >= 40 && Object.hasOwn(starterByTitle, task.title));
      if (!target) return this.text("当前没有可安全拆分的未完成任务；未保存调整草案。" + connection);
      const wording = starterByTitle[target.title];
      const starterId = randomUUID();
      const starter = {
        id: starterId, title: wording.title, action: wording.action, doneCriteria: wording.doneCriteria,
        evidenceType: target.evidenceType, estimateMinutes: 20, dueAt: target.dueAt, dependencyIds: target.dependencyIds,
      };
      const tasks = snapshot.tasks.flatMap(task => task.id === target.id
        ? [starter, { ...TaskCreateInputSchema.strip().parse(task), action: `${wording.remainingAction} 原任务要求：${task.action}`, estimateMinutes: task.estimateMinutes - 20, dependencyIds: [starterId] }]
        : [TaskCreateInputSchema.strip().parse(task)]);
      return call("propose_replan", { goalId: goal.id, payload: { base: { goalVersion: goal.version, planVersionId: goal.currentPlanVersionId }, tasks,
        milestones: snapshot.milestones, changeReason: "将未完成任务拆出可独立验收的二十分钟起步任务，原任务剩余估时相应减少，总估时与交付范围不变" } });
    }
    if (message === "请根据已记录的执行情况生成目标复盘。") {
      const done = snapshot.tasks.filter(t => t.status === "done").length;
      const minutes = snapshot.tasks.reduce((n, t) => n + (t.actualMinutes ?? 0), 0);
      return this.text(`当前计划共 ${snapshot.tasks.length} 项任务，已完成 ${done} 项；已记录实际耗时 ${minutes} 分钟，提交证据 ${snapshot.evidence.length} 条。以上只概括已保存记录。${connection}`);
    }
    return this.text(connection + "这段预设流程无法自动理解当前输入；可以使用界面提供的手动操作。");
  }
}
