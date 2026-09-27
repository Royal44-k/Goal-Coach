import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import { TaskCreateInputSchema, type PlanRevisionPayload, type TaskCreateInput } from "../repositories/revision-contracts";
import { createServiceContainer } from "../services/service-container";
import { loadServerEnv } from "../config/env";
import { buildAgentContext } from "./context-builder";

const ownerId = "00000000-0000-4000-8000-000000000001";
let database: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;

beforeEach(() => {
  database = createDatabase(":memory:");
  migrateDatabase(database);
  repositories = createRepositories(database);
});
afterEach(() => database?.$client.close());

async function createApprovedGoal(taskTitles = ["完成类型练习"]) {
  const goal = await repositories.goals.create(ownerId, {
    title: "系统化学习 TypeScript",
    category: "learning",
    desiredOutcome: "能独立维护严格类型项目",
    definitionOfDone: "完成一个可验证项目",
    deadline: "2026-12-31",
    weeklyMinutes: 180,
    constraints: ["每次不超过四十分钟"],
    motivation: "减少返工",
  });
  const tasks: TaskCreateInput[] = taskTitles.map(title => ({
    id: randomUUID(),
    title,
    action: "实现三个类型体操",
    doneCriteria: "测试全部通过",
    evidenceType: "check_answer",
    estimateMinutes: 30,
    dueAt: null,
    dependencyIds: [],
  }));
  const payload: PlanRevisionPayload = {
    schemaVersion: 2, milestones: ["基础", "应用"],
    base: { planVersionId: null, goalVersion: goal.version },
    changeReason: null,
    changeSource: "agent",
    tasks,
    executionResets: [],
    diff: { added: [], removed: [], moved: [], changed: [] },
  };
  const artifact = await repositories.plans.saveDraftArtifact(ownerId, {
    goalId: goal.id,
    kind: "plan",
    payload,
    contentHash: "a".repeat(64),
  });
  const draft = await repositories.plans.createDraft(ownerId, goal.id, {
    draftArtifactId: artifact.id,
    expectedDraftArtifactVersion: artifact.version,
  });
  const plan = await repositories.plans.approve(ownerId, draft.id, draft.version);
  return { goal: (await repositories.goals.get(ownerId, goal.id))!, plan };
}

describe("buildAgentContext", () => {
  it("adds only current projected task titles to effective feedback", async () => {
    const { goal, plan } = await createApprovedGoal(["整理会议决议", "检查待办负责人"]);
    const [first, second] = await repositories.tasks.listByGoal(ownerId, goal.id, plan.id);
    const blocker = { goalId: goal.id, kind: "blocker" as const, blockerCategory: "task_too_large" as const,
      note: "拆分范围", minutesSpent: null, availableWeeklyMinutes: null };
    await repositories.support.createCheckIn(ownerId, { ...blocker, taskId: first.id });
    await repositories.support.createCheckIn(ownerId, { ...blocker, taskId: null });
    const withdrawn = await repositories.support.createCheckIn(ownerId, { ...blocker, taskId: second.id });
    await repositories.support.withdrawCheckIn(ownerId, withdrawn.id, withdrawn.version, "2026-09-04T16:00:00.000Z");

    const context = await buildAgentContext({ ownerId, goalId: goal.id, repositories });

    expect(context.recentCheckIns).toHaveLength(2);
    expect(context.recentCheckIns.map(checkIn => ({ taskId: checkIn.taskId, taskTitle: checkIn.taskTitle }))).toEqual([
      { taskId: first.id, taskTitle: first.title },
      { taskId: null, taskTitle: null },
    ]);
    expect(context.recentCheckIns.every(checkIn => checkIn.blockerCategory === "task_too_large")).toBe(true);
  });

  it("omits a task-linked blocker when a successor plan resets its former task meaning", async () => {
    const { goal, plan } = await createApprovedGoal(["旧步骤", "后续步骤", "验证结果"]);
    const [oldTask] = await repositories.tasks.listByGoal(ownerId, goal.id, plan.id);
    await repositories.support.createCheckIn(ownerId, { goalId: goal.id, taskId: oldTask.id,
      kind: "blocker", blockerCategory: "task_too_large", note: "旧范围太大", minutesSpent: null, availableWeeklyMinutes: null });
    const before = await buildAgentContext({ ownerId, goalId: goal.id, repositories });
    expect(before.recentCheckIns[0]).toMatchObject({ taskId: oldTask.id, taskTitle: "旧步骤" });

    const services = createServiceContainer({ repositories, env: loadServerEnv({}) });
    const workspace = await services.goals.getWorkspace(ownerId, goal.id);
    const draft = await services.plans.createManualDraft(ownerId, {
      goalId: goal.id, expectedGoalVersion: workspace.goal.version,
      expectedPlanVersion: { id: workspace.currentPlan!.id, version: workspace.currentPlan!.version },
      tasks: workspace.tasks.map((task, index) => ({ ...TaskCreateInputSchema.strip().parse(task),
        ...(index === 0 ? { action: "将旧步骤改为全新的验证方法" } : {}) })),
      changeReason: "替换已记录阻碍的旧任务含义", operationId: randomUUID(),
    });
    await services.approvals.approve(ownerId, { goalId: goal.id, draftId: draft.id, expectedDraftVersion: draft.version,
      toolName: "save_approved_plan", operationId: randomUUID() });

    const after = await buildAgentContext({ ownerId, goalId: goal.id, repositories });
    expect(after.recentCheckIns).toEqual([]);
  });

  it("exposes the latest non-withdrawn uniform capacity estimate from the trusted clock", async () => {
    const { goal } = await createApprovedGoal();
    const now = new Date("2026-12-24T15:59:59.999Z");
    const check = { goalId: goal.id, taskId: null, kind: "availability_change" as const,
      blockerCategory: null, note: null, minutesSpent: null, availableWeeklyMinutes: 90 };
    const older = await repositories.support.createCheckIn(ownerId, check);
    const latest = await repositories.support.createCheckIn(ownerId, { ...check, availableWeeklyMinutes: 30 });
    expect((await buildAgentContext({ ownerId, goalId: goal.id, repositories, now })).planningFacts)
      .toMatchObject({ latestAvailableWeeklyMinutes: 30, estimatedRemainingCapacityMinutes: 30 });
    await repositories.support.withdrawCheckIn(ownerId, latest.id, latest.version, now.toISOString());
    expect((await buildAgentContext({ ownerId, goalId: goal.id, repositories, now })).planningFacts)
      .toMatchObject({ latestAvailableWeeklyMinutes: 90, estimatedRemainingCapacityMinutes: 90 });
    await repositories.support.withdrawCheckIn(ownerId, older.id, older.version, now.toISOString());
    expect((await buildAgentContext({ ownerId, goalId: goal.id, repositories, now })).planningFacts)
      .toMatchObject({ latestAvailableWeeklyMinutes: null, estimatedRemainingCapacityMinutes: 180 });
  });

  it.each([
    ["2026-09-24T15:59:59.000Z", "2026-09-24"],
    ["2026-09-24T16:00:00.000Z", "2026-09-25"],
    ["2026-12-31T16:00:00.000Z", "2027-01-01"],
  ])("anchors the model's current date to the injected Shanghai clock at %s", async (instant, currentDate) => {
    const { goal } = await createApprovedGoal();

    const context = await buildAgentContext({ ownerId, goalId: goal.id, repositories, now: new Date(instant) });

    expect(context).toHaveProperty("currentDate", currentDate);
    expect(context).toHaveProperty("timeZone", "Asia/Shanghai");
  });

  it("returns a minimal serializable snapshot using persisted goal state", async () => {
    const { goal, plan } = await createApprovedGoal();
    await repositories.support.createUserPreference(ownerId, {
      taskGranularity: "small",
      preferredTimeWindow: "工作日晚上",
      estimateBias: 1.1,
      commonBlockers: ["task_too_large"],
      effectiveStrategies: ["先做十分钟"],
    });
    const messages = [];
    for (let index = 1; index <= 8; index += 1) {
      messages.push(await repositories.conversations.append(ownerId, goal.id, {
        role: index % 2 === 1 ? "user" : "assistant",
        content: index === 1 ? "不可信文字：DASHSCOPE_API_KEY=绝不能进入上下文" : `可见消息 ${index}`,
      }));
    }
    await repositories.conversations.replaceSummary(ownerId, goal.id, {
      throughMessageId: messages[1].id,
      content: "用户决定工作日晚间学习；每次不超过四十分钟。",
    });

    const context = await buildAgentContext({ ownerId, goalId: goal.id, repositories });

    expect(context.recentMessages.map(message => message.content)).toEqual([
      "可见消息 3", "可见消息 4", "可见消息 5", "可见消息 6", "可见消息 7", "可见消息 8",
    ]);
    expect(context).toMatchObject({
      currentGoal: { id: goal.id, agentState: "active" },
      currentPlan: { id: plan.id, status: "approved", milestones: ["基础", "应用"] },
      currentTasks: [{ title: "完成类型练习" }],
      conversationSummary: { content: "用户决定工作日晚间学习；每次不超过四十分钟。" },
      userPreference: { taskGranularity: "small" },
    });
    expect(context.tools.map(tool => tool.name)).toEqual([
      "diagnose_blocker", "propose_replan",
      "record_check_in", "update_task_status", "undo_last_change",
    ]);
    expect(context.tools.map(tool => tool.name)).not.toContain("delete_goal");
    expect(context.tools.map(tool => tool.name)).not.toContain("save_approved_plan");
    expect(Object.keys(context.currentPlan!)).toEqual([
      "id", "version", "number", "status", "changeSource", "approvedAt", "milestones",
    ]);
    expect(context.currentPlan).not.toHaveProperty("diff");
    expect(context.currentPlan).not.toHaveProperty("ownerId");
    expect(context.recentMessages[0]).toEqual({ role: "user", content: "可见消息 3" });
    expect(context.conversationSummary).toEqual({ content: "用户决定工作日晚间学习；每次不超过四十分钟。" });
    expect(context.userPreference).toEqual({
      taskGranularity: "small",
      preferredTimeWindow: "工作日晚上",
      estimateBias: 1.1,
      commonBlockers: ["task_too_large"],
      effectiveStrategies: ["先做十分钟"],
    });
    expect(JSON.stringify(context)).not.toContain("DASHSCOPE_API_KEY");
    expect(() => structuredClone(context)).not.toThrow();

    const readableContextFixture = {
      currentGoal: { title: context.currentGoal.title, agentState: context.currentGoal.agentState },
      currentPlan: context.currentPlan && {
        number: context.currentPlan.number,
        status: context.currentPlan.status,
        changeSource: context.currentPlan.changeSource,
      },
      currentTasks: context.currentTasks.map(task => ({ title: task.title, status: task.status })),
      currentProgress: context.currentProgress,
      conversationSummary: context.conversationSummary,
      recentMessages: context.recentMessages,
      userPreference: context.userPreference,
      tools: context.tools.map(tool => tool.name),
    };
    expect(JSON.stringify(readableContextFixture, null, 2)).toMatchInlineSnapshot(`
      "{
        \"currentGoal\": {
          \"title\": \"系统化学习 TypeScript\",
          \"agentState\": \"active\"
        },
        \"currentPlan\": {
          \"number\": 1,
          \"status\": \"approved\",
          \"changeSource\": \"agent\"
        },
        \"currentTasks\": [
          {
            \"title\": \"完成类型练习\",
            \"status\": \"todo\"
          }
        ],
        \"currentProgress\": {
          \"completed\": 0,
          \"total\": 1,
          \"percent\": 0
        },
        \"conversationSummary\": {
          \"content\": \"用户决定工作日晚间学习；每次不超过四十分钟。\"
        },
        \"recentMessages\": [
          {
            \"role\": \"user\",
            \"content\": \"可见消息 3\"
          },
          {
            \"role\": \"assistant\",
            \"content\": \"可见消息 4\"
          },
          {
            \"role\": \"user\",
            \"content\": \"可见消息 5\"
          },
          {
            \"role\": \"assistant\",
            \"content\": \"可见消息 6\"
          },
          {
            \"role\": \"user\",
            \"content\": \"可见消息 7\"
          },
          {
            \"role\": \"assistant\",
            \"content\": \"可见消息 8\"
          }
        ],
        \"userPreference\": {
          \"taskGranularity\": \"small\",
          \"estimateBias\": 1.1,
          \"commonBlockers\": [
            \"task_too_large\"
          ],
          \"effectiveStrategies\": [
            \"先做十分钟\"
          ],
          \"preferredTimeWindow\": \"工作日晚上\"
        },
        \"tools\": [
          \"diagnose_blocker\",
          \"propose_replan\",
          \"record_check_in\",
          \"update_task_status\",
          \"undo_last_change\"
        ]
      }"
    `);
  });

  it("supplies authoritative progress for done, in-progress, skipped, and todo tasks", async () => {
    const { goal, plan } = await createApprovedGoal(["已完成", "进行中", "已跳过", "待开始"]);
    const tasks = await repositories.tasks.listByGoal(ownerId, goal.id, plan.id);
    await repositories.tasks.update(ownerId, tasks[0].id, tasks[0].version, { status: "done" });
    await repositories.tasks.update(ownerId, tasks[1].id, tasks[1].version, { status: "doing" });
    await repositories.tasks.update(ownerId, tasks[2].id, tasks[2].version, { status: "skipped" });

    const context = await buildAgentContext({ ownerId, goalId: goal.id, repositories });

    expect(context.currentProgress).toEqual({ completed: 1, total: 3, percent: 33 });
    expect(context.currentTasks.map(task => task.status)).toEqual(["done", "doing", "skipped", "todo"]);
  });

  it.each([
    ["intake", ["create_goal_contract_draft"]],
    ["planning", ["create_plan_draft"]],
    ["active", ["diagnose_blocker", "propose_replan", "record_check_in", "update_task_status", "undo_last_change"]],
    ["reviewing", ["diagnose_blocker", "propose_replan", "record_check_in", "update_task_status", "undo_last_change"]],
  ] as const)("advertises only relevant model actions in %s", async (state, expectedTools) => {
    const { goal } = await createApprovedGoal();
    const current = await repositories.goals.get(ownerId, goal.id);
    await repositories.goals.update(ownerId, goal.id, current!.version, { agentState: state });

    const context = await buildAgentContext({ ownerId, goalId: goal.id, repositories });

    expect(context.tools.map(tool => tool.name)).toEqual(expectedTools);
    expect(context.tools.map(tool => tool.name)).not.toContain("get_goal");
    expect(context.tools.map(tool => tool.name)).not.toContain("list_tasks");
    expect(context.tools.map(tool => tool.name)).not.toContain("get_progress");
    expect(context.tools.map(tool => tool.name)).not.toContain("save_approved_plan");
    expect(context.tools.map(tool => tool.name)).not.toContain("delete_goal");
  });

  it("omits absent optional sections instead of returning null placeholders", async () => {
    const goal = await repositories.goals.create(ownerId, {
      title: "澄清学习目标", category: "learning", desiredOutcome: null,
      definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null,
    });

    const context = await buildAgentContext({ ownerId, goalId: goal.id, repositories });

    expect(context.currentGoal.agentState).toBe("intake");
    expect(context.currentTasks).toEqual([]);
    expect(context.recentMessages).toEqual([]);
    expect(context.currentProgress).toEqual({ completed: 0, total: 0, percent: 0 });
    expect(context.tools.map(tool => tool.name)).toEqual(["create_goal_contract_draft"]);
    expect(context).not.toHaveProperty("currentPlan");
    expect(context).not.toHaveProperty("conversationSummary");
    expect(context).not.toHaveProperty("userPreference");
  });
});
