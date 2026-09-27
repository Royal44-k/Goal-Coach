import { describe, expect, it } from "vitest";
import {
  AgentRunSchema,
  AppSettingSchema,
  ApprovalGrantSchema,
  AuditEventSchema,
  CheckInSchema,
  ConversationMessageSchema,
  ConversationSummarySchema,
  DraftArtifactSchema,
  GoalInputSchema,
  CompleteGoalContractSchema,
  GoalSchema,
  OperationSchema,
  PlanVersionSchema,
  TaskEvidenceSchema,
  TaskSchema,
  UndoRecordSchema,
  UserPreferenceSchema,
} from "./contracts";

it("requires all six contract values independently of draft lifecycle", () => {
  const complete = { title: "目标", category: "learning", desiredOutcome: "读懂", definitionOfDone: "能复述", deadline: "2026-12-01", weeklyMinutes: 60, constraints: [], motivation: "兴趣" };
  expect(CompleteGoalContractSchema.safeParse(complete).success).toBe(true);
  for (const field of ["desiredOutcome", "definitionOfDone", "deadline", "weeklyMinutes", "constraints", "motivation"])
    expect(CompleteGoalContractSchema.safeParse({ ...complete, [field]: null }).success).toBe(false);
});

const ids = {
  owner: "7ad27291-faad-4db3-9815-00929a57fe76",
  goal: "6dc5dc16-4ad9-4b1b-a8f5-e77527f0a335",
  task: "0933f72b-0bd4-4a5d-ad8e-98c3c16d5385",
  plan: "67548638-b2d7-4a29-a936-c5de40c3c77f",
  entity: "3b4f012b-73d8-4454-811d-f51e61a81396",
  message: "e6771d62-c67a-4ab1-b9b0-f7b1064d8ed9",
};

const timestamps = {
  createdAt: "2026-09-15T08:00:00.000Z",
  updatedAt: "2026-09-15T08:30:00.000Z",
};

const entityFields = {
  id: ids.entity,
  ownerId: ids.owner,
  ...timestamps,
  version: 1,
};

const validDraftGoal = {
  ...entityFields,
  id: ids.goal,
  title: "完成本地目标教练 MVP",
  category: "light_work",
  status: "draft",
  agentState: "intake",
  clarificationCount: 0,
  currentPlanVersionId: null,
  desiredOutcome: null,
  definitionOfDone: null,
  deadline: null,
  weeklyMinutes: null,
  constraints: null,
  motivation: null,
};

const validGoal = {
  ...validDraftGoal,
  status: "active",
  agentState: "active",
  currentPlanVersionId: ids.plan,
  desiredOutcome: "交付可运行的单用户 MVP",
  definitionOfDone: "所有验收检查通过",
  deadline: "2026-10-31",
  weeklyMinutes: 300,
  constraints: ["只在 Windows 回环地址运行"],
  motivation: "把复杂目标拆成可执行行动",
};

const validTask = {
  ...entityFields,
  id: ids.task,
  goalId: ids.goal,
  planVersionId: ids.plan,
  title: "定义领域契约",
  action: "编写并验证 Zod schema",
  doneCriteria: "领域测试全部通过",
  evidenceType: "text",
  estimateMinutes: 45,
  actualMinutes: null,
  dueAt: "2026-09-16",
  dependencyIds: [],
  status: "todo",
};

const validGrant = {
  ...entityFields,
  subjectId: ids.task,
  contentHash: "a".repeat(64),
  allowedTool: "update_task",
  expiresAt: "2026-09-15T08:15:00.000Z",
  usedAt: null,
};

const validMessage = {
  ...entityFields,
  id: ids.message,
  goalId: ids.goal,
  role: "user",
  content: "我今天完成了测试。",
};

describe("GoalSchema", () => {
  it("rejects a zero weekly minute budget", () => {
    expect(() => GoalSchema.parse({ ...validGoal, weeklyMinutes: 0 })).toThrow();
  });

  it("accepts a draft with nullable contract fields and explicit server state", () => {
    expect(GoalSchema.parse(validDraftGoal)).toMatchObject({
      status: "draft",
      agentState: "intake",
      clarificationCount: 0,
      currentPlanVersionId: null,
    });
  });

  it("rejects a non-draft goal with an incomplete contract", () => {
    expect(() => GoalSchema.parse({ ...validDraftGoal, status: "active" })).toThrow();
  });

  it("rejects malformed calendar dates instead of checking only their shape", () => {
    expect(() => GoalSchema.parse({ ...validGoal, deadline: "2026-02-30" })).toThrow();
  });
});

describe("GoalInputSchema", () => {
  const input = {
    title: validDraftGoal.title,
    category: validDraftGoal.category,
    desiredOutcome: null,
    definitionOfDone: null,
    deadline: null,
    weeklyMinutes: null,
    constraints: null,
    motivation: null,
  };

  it("accepts browser-editable goal fields", () => {
    expect(GoalInputSchema.parse(input)).toEqual(input);
  });

  it.each(["ownerId", "status", "agentState", "clarificationCount", "version"])(
    "rejects the server-managed %s field",
    (field) => {
      expect(() =>
        GoalInputSchema.parse({ ...input, [field]: validDraftGoal[field as keyof typeof validDraftGoal] }),
      ).toThrow();
    },
  );
});

describe("TaskSchema", () => {
  it("rejects a self dependency", () => {
    expect(() => TaskSchema.parse({ ...validTask, dependencyIds: [validTask.id] })).toThrow();
  });

  it("accepts null for unknown actual minutes and rejects a fabricated zero", () => {
    expect(TaskSchema.parse(validTask).actualMinutes).toBeNull();
    expect(() => TaskSchema.parse({ ...validTask, actualMinutes: 0 })).toThrow();
  });
});

describe("CheckInSchema", () => {
  const base = {
    ...entityFields,
    goalId: ids.goal,
    taskId: null,
    kind: "reflection",
    blockerCategory: null,
    note: "今天的拆分粒度合适。",
    minutesSpent: null,
    availableWeeklyMinutes: null,
  };

  it("requires a blocker category for blocker check-ins", () => {
    expect(() => CheckInSchema.parse({ ...base, kind: "blocker", note: null })).toThrow();
  });

  it("requires positive availability for availability changes", () => {
    expect(() =>
      CheckInSchema.parse({ ...base, kind: "availability_change", note: null }),
    ).toThrow();
    expect(() =>
      CheckInSchema.parse({
        ...base,
        kind: "availability_change",
        note: null,
        availableWeeklyMinutes: 0,
      }),
    ).toThrow();
  });

  it.each([
    ["progress", { taskId: null, note: null, minutesSpent: null }],
    ["evidence", { taskId: null, note: null }],
    ["reflection", { note: null }],
  ])("requires a relevant value for %s check-ins", (kind, emptyFields) => {
    expect(() => CheckInSchema.parse({ ...base, kind, ...emptyFields })).toThrow();
  });
});

describe("approval and operation safety contracts", () => {
  it("rejects a non-canonical approval content hash", () => {
    expect(() => ApprovalGrantSchema.parse({ ...validGrant, contentHash: "short" })).toThrow();
    expect(() =>
      ApprovalGrantSchema.parse({ ...validGrant, contentHash: "A".repeat(64) }),
    ).toThrow();
  });

  it("accepts a grant lasting exactly fifteen minutes", () => {
    expect(ApprovalGrantSchema.parse(validGrant).expiresAt).toBe(
      "2026-09-15T08:15:00.000Z",
    );
  });

  it.each([
    ["a zero-length lifetime", "2026-09-15T08:00:00.000Z"],
    ["an expiry before creation", "2026-09-15T07:59:59.999Z"],
    ["a lifetime over fifteen minutes", "2026-09-15T08:15:00.001Z"],
  ])("rejects %s", (_label, expiresAt) => {
    expect(() => ApprovalGrantSchema.parse({ ...validGrant, expiresAt })).toThrow();
  });

  it("accepts composite operation IDs and a JSON-safe result", () => {
    const operation = OperationSchema.parse({
      ...entityFields,
      goalId: ids.goal,
      operationId: "request-42:tool-call-7",
      toolName: "update_task",
      parameterHash: "b".repeat(64),
      status: "succeeded",
      result: { taskId: ids.task, changed: true, attempts: 1 },
    });

    expect(operation.operationId).toBe("request-42:tool-call-7");
  });

  it("accepts a goal-less clear operation without fabricating a goal ID", () => {
    const operation = OperationSchema.parse({
      ...entityFields,
      goalId: null,
      operationId: "request-43:tool-call-1",
      toolName: "clear_all_data",
      parameterHash: "d".repeat(64),
      status: "succeeded",
      result: { cleared: true },
    });

    expect(operation.goalId).toBeNull();
  });

  it("still rejects a non-null operation goal reference that is not a UUID", () => {
    expect(() =>
      OperationSchema.parse({
        ...entityFields,
        goalId: "fabricated-goal",
        operationId: "request-43:tool-call-2",
        toolName: "update_task",
        parameterHash: "d".repeat(64),
        status: "succeeded",
        result: { changed: true },
      }),
    ).toThrow();
  });

  it.each([
    ["undefined", { value: undefined }],
    ["a function", { value: () => "unsafe" }],
    ["a non-finite number", { value: Number.POSITIVE_INFINITY }],
  ])("rejects %s in replay results", (_label, result) => {
    expect(() =>
      OperationSchema.parse({
        ...entityFields,
        goalId: ids.goal,
        operationId: "request-42:tool-call-7",
        toolName: "update_task",
        parameterHash: "b".repeat(64),
        status: "succeeded",
        result,
      }),
    ).toThrow();
  });
});

describe("conversation contracts", () => {
  it.each(["system", "tool"])("rejects the %s role", (role) => {
    expect(() => ConversationMessageSchema.parse({ ...validMessage, role })).toThrow();
  });

  it("accepts a summary through a concrete message", () => {
    expect(
      ConversationSummarySchema.parse({
        ...entityFields,
        goalId: ids.goal,
        throughMessageId: ids.message,
        content: "用户完成了领域测试。",
      }).throughMessageId,
    ).toBe(ids.message);
  });
});

describe("remaining entity schemas", () => {
  it("accepts representative valid records", () => {
    const records = [
      PlanVersionSchema.parse({
        ...entityFields,
        goalId: ids.goal,
        number: 1,
        status: "approved",
        changeReason: "初始计划",
        changeSource: "agent",
        diff: { addedTaskIds: [ids.task] },
        approvedAt: "2026-09-15T08:20:00.000Z",
      }),
      DraftArtifactSchema.parse({
        ...entityFields,
        goalId: ids.goal,
        kind: "plan",
        payload: { title: "第一版计划" },
        contentHash: "c".repeat(64),
        status: "approved",
      }),
      TaskEvidenceSchema.parse({
        ...entityFields,
        goalId: ids.goal,
        taskId: ids.task,
        type: "text",
        text: "测试通过",
        fileName: null,
        fileSize: null,
        mimeType: null,
      }),
      AgentRunSchema.parse({
        ...entityFields,
        goalId: ids.goal,
        startState: "planning",
        endState: "plan_review",
        status: "succeeded",
        model: "mock",
        inputTokenCount: 0,
        outputTokenCount: 0,
        toolCallCount: 0,
        latencyMs: 0,
        errorCode: null,
      }),
      UndoRecordSchema.parse({
        ...entityFields,
        kind: "task_execution", checkInId: null, ordinal: 1, conversationFence: null,
        goalId: ids.goal,
        taskId: ids.task,
        forwardPatch: { status: "done" },
        reversePatch: { status: "doing" },
        undoneAt: null,
      }),
      UserPreferenceSchema.parse({
        ...entityFields,
        taskGranularity: "small",
        preferredTimeWindow: "工作日晚上",
        estimateBias: 1,
        commonBlockers: ["task_too_large"],
        effectiveStrategies: ["先做十分钟"],
      }),
      AuditEventSchema.parse({
        id: ids.entity,
        ownerId: ids.owner,
        goalId: ids.goal,
        type: "task.updated",
        entityType: "task",
        entityId: ids.task,
        detail: { previousStatus: "doing", nextStatus: "done" },
        createdAt: timestamps.createdAt,
        version: 1,
      }),
      AppSettingSchema.parse({
        ...entityFields,
        privacyAcceptedAt: null,
        privacyProvider: null,
        privacyPolicyVersion: null,
        provider: "mock",
        model: "mock",
        fallbackEnabled: true,
        dailyInputTokenLimit: 20_000,
        dailyOutputTokenLimit: 8_000,
      }),
    ];

    expect(records).toHaveLength(8);
  });
});
