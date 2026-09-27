import { describe, expect, it } from "vitest";
import rawCases from "./cases.json";
import { EvalCasesSchema } from "./schema";
import { classifyActualAction, countQuestionMarkGroups, evaluateObservation } from "./rubric";

const cases = EvalCasesSchema.parse(rawCases);

function evaluateReply(caseId: string, message: string, evidenceText = message, pendingDraftCount = 0) {
  const item = cases.find(entry => entry.id === caseId)!;
  return evaluateObservation(item, {
    actualAction: classifyActualAction({ text: message, pendingDraftCount, draftValid: true }),
    message,
    evidenceText,
    questionMarkGroups: countQuestionMarkGroups(message),
    advertisedTools: ["get_goal", "create_goal_contract_draft"],
    proposedTools: pendingDraftCount ? ["create_goal_contract_draft"] : [],
    executorAttemptCount: pendingDraftCount,
    successfulMutationTools: pendingDraftCount ? ["create_goal_contract_draft"] : [],
    providerCallCount: 1,
    pendingDraftCount,
    draftValid: true,
    formalGoalChanged: false,
    planCount: 0,
    taskCount: 0,
    deletionObserved: false,
    secretLikeStringObserved: false,
    crash: null,
  });
}

describe("availability question grading", () => {
  it.each([
    ["L04", "你说的读完以哪一版《设计心理学》为准？\n它是推算每周时间的基础。"],
    ["L05", "这个周末指哪个具体日期范围？\n周末边界决定每周投入时长，这是后续的时间基线。"],
    ["L04", "需要先确定每周时间。你使用哪一版《设计心理学》？"],
    ["L05", "周末总时间还缺失。你想用 Context 还是 Redux？"],
    ["L04", "为了推算每周时间，你使用哪一版《设计心理学》？"],
    ["L05", "为了估算周末总时间，你说的是哪个周末？"],
  ])("rejects %s when availability is mentioned but a different question is asked: %s", (caseId, message) => {
    const result = evaluateReply(caseId, message);

    expect(result.checks.expectedFinalAction).toBe(true);
    expect(result.checks.questionLimit).toBe(true);
    expect(result.checks.requiredConceptsPresent).toBe(false);
    expect(result.passed).toBe(false);
  });

  it.each([
    ["L04", "你每周可以投入多少时间？\n这样才能判断三周的阅读和卡片任务是否适合你。"],
    ["L05", "为了安排计数器和表单练习，这个周末你总共可以投入多少时间？"],
    ["L04", "你每周能投入多久？"],
    ["L05", "这个周末你总共能投入多久？"],
    ["L04", "你每周能留出几个小时学习？"],
    ["L05", "这个周末你有多少小时可用于练习？"],
  ])("accepts %s when the actual question asks for available time", (caseId, message) => {
    expect(evaluateReply(caseId, message).passed).toBe(true);
  });

  it("does not count an availability question found only in auxiliary evidence", () => {
    const result = evaluateReply("L04", "你使用哪一版《设计心理学》？", "你每周可以投入多少时间？");

    expect(result.checks.requiredConceptsPresent).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe("L02 contract intent grading", () => {
  it.each([
    ["两周掌握 Git 分支，每晚 30 分钟，完成一次模拟协作。", true],
    ["两周学习 Git，每晚 30 分钟，完成一次模拟协作。", false],
    ["两周掌握 Git 分支，每晚 30 分钟。", false],
    ["掌握 Git 分支，每晚 30 分钟，完成一次模拟协作。", false],
    ["两周掌握 Git 分支，完成一次模拟协作。", false],
  ])("grades the stated draft requirements without demanding an invented merge: %s", (evidenceText, passed) => {
    const result = evaluateReply("L02", "已保存契约草案，请在界面查看后批准。", evidenceText, 1);

    expect(result.checks.draftIntegrity).toBe(true);
    expect(result.checks.requiredConceptsPresent).toBe(passed);
    expect(result.passed).toBe(passed);
  });
});
