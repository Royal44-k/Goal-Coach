import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseLifecycleArgs, runLifecycleEvaluation } from "./lifecycle-run";
import { lifecycleScenarios } from "./lifecycle-scenarios";
import { approvedReplanPreserved, pendingReplanPreserved, proposedUnfinishedDuesWithinDeadline, proposedUnfinishedWithinCapacity,
  proposedUnchangedWorkEstimatesPreserved, proposedRemainingWorkloadPreserved, capacityRefusalMatches, currentCapacityRefusalMatches } from "./lifecycle-support";
import type { GoalWorkspace } from "@/server/services/service-contracts";
import type { ModelRequest } from "@/server/agent/model-contracts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function outputDir() { const dir = mkdtempSync(join(tmpdir(), "goal-lifecycle-")); dirs.push(dir); return dir; }

it("keeps the light-work live intake explicitly synthetic without changing the approved fixture", () => {
  const scenario = lifecycleScenarios(new Date("2026-09-27T00:00:00Z")).find(item => item.id === "light_work")!;
  expect(scenario.intake).toContain("用合成的团队会议样本完成整理演练");
  expect(scenario.intake).toContain("交付可检索的演练目录");
  expect(scenario.intake).toContain("决议、负责人和待办项");
  expect(scenario.intake).toContain("用合成样本验证");
  expect(scenario.contract.constraints).toContain("只使用合成会议记录");
});

it("rejects unapproved live evaluation before creating output or loading configuration", async () => {
  const directory = join(outputDir(), "no-output");
  const env = vi.fn(() => { throw new Error("Private config was touched"); });
  const options = { provider: "deepseek" as const, allowLive: false, scenario: "learning" as const, outputDir: directory,
    get env() { return env(); } };
  await expect(runLifecycleEvaluation(options)).rejects.toThrow(/allow-live/);
  expect(env).not.toHaveBeenCalled();
  expect(() => readFileSync(join(directory, "learning.json"))).toThrow();
  expect(() => parseLifecycleArgs(["--provider=deepseek"])).toThrow(/allow-live/);
  expect(parseLifecycleArgs([])).toEqual({ provider: "mock", scenario: "all", allowLive: false });
});

it("runs both synthetic goals through persisted lifecycle and reports actual calls", async () => {
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario: "all", outputDir: outputDir(), now: new Date() });
  expect(summary, JSON.stringify(summary.resultFiles.map(path => JSON.parse(readFileSync(path, "utf8")).stages.at(-1)))).toMatchObject({ totalScenarios: 2, passed: 2, failed: 0 });
  expect(summary.providerCalls).toBeGreaterThan(0);
  for (const path of summary.resultFiles) {
    const result = JSON.parse(readFileSync(path, "utf8"));
    expect(result.passed).toBe(true);
    expect(result.stages.map((stage: { name: string }) => stage.name)).toEqual(expect.arrayContaining([
      "contract_draft", "contract_approval", "plan_draft", "plan_approval", "execution_undo", "blocker_advice", "replan_draft", "replan_approval", "review", "completion", "owner_export",
    ]));
    expect(result.stages.find((stage: { name: string }) => stage.name === "contract_draft").draft.payload.contract.definitionOfDone).toBeTruthy();
    expect(result.stages.find((stage: { name: string }) => stage.name === "contract_draft").draft.payload.assumptions).toEqual([]);
    expect(result.stages.find((stage: { name: string }) => stage.name === "replan_draft").draft.payload.tasks.length).toBeGreaterThanOrEqual(3);
    expect(result.stages.find((stage: { name: string }) => stage.name === "owner_export").exportCounts.evidence).toBeGreaterThan(0);
    expect(result.stages.find((stage: { name: string }) => stage.name === "contract_draft").invariants.formalGoalUnchanged).toBe(true);
    expect(result.stages.find((stage: { name: string }) => stage.name === "plan_draft").invariants.currentPlanUnchanged).toBe(true);
    expect(result.stages.find((stage: { name: string }) => stage.name === "replan_draft").invariants.completedEvidencePreserved).toBe(true);
    expect(result.stages.find((stage: { name: string }) => stage.name === "replan_draft").invariants.unfinishedDuesWithinDeadline).toBe(true);
    expect(result.stages.find((stage: { name: string }) => stage.name === "replan_draft").invariants.unchangedWorkEstimatesPreserved).toBe(true);
    expect(result.stages.find((stage: { name: string }) => stage.name === "replan_draft").invariants.remainingWorkloadPreserved).toBe(true);
    expect(result.stages.find((stage: { name: string }) => stage.name === "contract_draft").invariants.replayProviderCallsUnchanged).toBe(true);
    for (const stageName of ["plan_draft", "replan_draft"]) {
      const stage = result.stages.find((item: { name: string }) => item.name === stageName);
      expect(stage.providerCalls.flatMap((call: { planDiagnostics?: unknown[] }) => call.planDiagnostics ?? []))
        .toEqual([expect.objectContaining({ status: "valid", taskCount: stageName === "replan_draft" ? 4 : 3, withinTaskRange: true,
          baseGoalVersionMatches: true, basePlanVersionMatches: true, canonicalDiffDerived: true,
          canonicalExecutionResetsDerived: true, hasPlanChange: true })]);
      expect(stage.providerCalls.map((call: { attemptOrdinal?: number }) => call.attemptOrdinal)).toEqual([1]);
      expect(stage.providerCalls.map((call: { finishReason?: string }) => call.finishReason)).toEqual(["tool_calls"]);
      const exactMinutes = stage.draft.payload.tasks.reduce((sum: number, task: { estimateMinutes: number }) => sum + task.estimateMinutes, 0);
      expect(stage.reply).toMatch(new RegExp(`总估时\\s*${exactMinutes}\\s*分钟`, "u"));
    }
  }
}, 20_000);

it("stops after invalid model draft and saves stage failure evidence", async () => {
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario: "learning", outputDir: outputDir(), mockFailure: "invalid_contract" });
  expect(summary).toMatchObject({ totalScenarios: 1, passed: 0, failed: 1 });
  const result = JSON.parse(readFileSync(summary.resultFiles[0], "utf8"));
  expect(result.stages.some((stage: { name: string }) => stage.name === "contract_approval")).toBe(false);
  expect(result.stages.at(-1)).toMatchObject({ name: "contract_draft", passed: false, error: { code: expect.any(String) } });
  expect(result.providerCalls.length).toBeGreaterThan(0);
});

it.each(["learning", "light_work"] as const)("keeps explicit user time choice for %s separate with unchanged formal commitments", async scenario => {
  expect(parseLifecycleArgs([`--scenario=${scenario}`, "--replan-mode=confirm-more-time"]))
    .toMatchObject({ replanMode: "confirm-more-time" });
  const turns: string[] = [];
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario,
    replanMode: "confirm-more-time", outputDir: outputDir(), mockTurnObserver: turn => turns.push(turn.message) });
  expect(summary.passed).toBe(1);
  expect(summary.resultFiles[0]).toMatch(new RegExp(`${scenario}_user_chose_more_time\\.json$`, "u"));
  const result = JSON.parse(readFileSync(summary.resultFiles[0], "utf8"));
  const choice = result.stages.find((stage: { name: string }) => stage.name === "explicit_user_time_choice");
  expect(choice.invariants).toMatchObject({ formalCommitmentsUnchanged: true, executionUnchanged: true, availabilityRecorded: true });
  expect(choice.after.checkInCount).toBe(choice.before.checkInCount + 1);
  expect(choice.after.formalContract).toEqual(choice.before.formalContract);
  expect(turns.at(-2)).toContain(`我明确选择将每周可用时间恢复为 ${scenario === "learning" ? 240 : 180} 分钟`);
  expect(result.acceptanceScope).toBe("full_lifecycle_after_explicit_time_choice");
}, 20_000);

it("rejects aggregate unfinished discounts even when wording and IDs change, independently of production", () => {
  const before = { tasks: [
    { id: "done", status: "done", estimateMinutes: 500 },
    { id: "skip", status: "skipped", estimateMinutes: 900 },
    { id: "a", status: "blocked", estimateMinutes: 90 },
    { id: "b", status: "todo", estimateMinutes: 130 },
  ] } as GoalWorkspace;
  type Proposal = Parameters<typeof proposedRemainingWorkloadPreserved>[1];
  const proposal = (tasks: object[], reset: string[] = []) => ({ tasks,
    executionResets: reset.map(taskKey => ({ taskKey })) }) as Proposal;
  const retained = [{ id: "done", estimateMinutes: 500 }, { id: "skip", estimateMinutes: 900 }];
  expect(proposedRemainingWorkloadPreserved(before, proposal([...retained,
    { id: "starter", action: "new wording", estimateMinutes: 25 }, { id: "merged", estimateMinutes: 90 }]))).toBe(false);
  expect(proposedRemainingWorkloadPreserved(before, proposal([...retained,
    { id: "starter", estimateMinutes: 25 }, { id: "merged", estimateMinutes: 195 }]))).toBe(true);
  expect(proposedRemainingWorkloadPreserved(before, proposal(retained))).toBe(false);
  expect(proposedRemainingWorkloadPreserved(before, proposal(retained, ["skip"]))).toBe(true);
  expect(proposedRemainingWorkloadPreserved({ tasks: [] } as unknown as GoalWorkspace,
    proposal([{ id: "new", estimateMinutes: 30 }]))).toBe(true);
});

it("records a capacity refusal as a separate safety case, never as completed lifecycle", async () => {
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario: "learning",
    replanMode: "expect-capacity-conflict", outputDir: outputDir() });
  expect(summary.passed, JSON.stringify(JSON.parse(readFileSync(summary.resultFiles[0], "utf8")).stages.at(-1))).toBe(1);
  expect(summary.resultFiles[0]).toMatch(/learning_capacity_conflict\.json$/u);
  const result = JSON.parse(readFileSync(summary.resultFiles[0], "utf8"));
  expect(result.acceptanceScope).toBe("capacity_refusal_only");
  expect(result.stages.at(-1)).toMatchObject({ name: "capacity_conflict_refusal", passed: true,
    capacityEvidence: "rejected_proposal_tool_feedback",
    invariants: { formalAndExecutionUnchanged: true, knownCapacityConstraint: true, noPendingDraft: true } });
  expect(result.stages.some((stage: { name: string }) => stage.name === "completion")).toBe(false);
  expect(result.stages.at(-1).before).toEqual(result.stages.at(-1).after);
  expect(result.stages.at(-1).capacity.proposedUnfinishedMinutes).toBeGreaterThan(result.stages.at(-1).capacity.estimatedRemainingMinutes);
}, 20_000);

it("recognizes a trusted current-capacity notice without requiring an invalid tool attempt", async () => {
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario: "learning",
    replanMode: "expect-capacity-conflict", outputDir: outputDir(), mockFailure: "unexplained_refusal" });
  expect(summary).toMatchObject({ passed: 1, failed: 0 });
  const result = JSON.parse(readFileSync(summary.resultFiles[0], "utf8"));
  expect(result.stages.at(-1)).toMatchObject({ capacityEvidence: "current_plan_no_tools",
    invariants: { formalAndExecutionUnchanged: true, knownCapacityConstraint: true, noPendingDraft: true } });
  expect(result.stages.at(-1).providerCalls.every((call: { toolCallCount?: number }) => call.toolCallCount === 0)).toBe(true);
  expect(() => parseLifecycleArgs(["--replan-mode=anything"])).toThrow();
  expect(() => parseLifecycleArgs(["--replan-mode=confirm-more-time"])).toThrow(/learning/u);
});

it("rejects misleading nonempty replies even with genuine capacity feedback", () => {
  const capacity = { estimatedRemainingMinutes: 485, proposedUnfinishedMinutes: 680 };
  const reply = "这份计划提案未保存：未完成工作的估时超过按当前信息估算的剩余可用时间。刚才被拒绝提案校验时：未完成估时680分钟，可用485分钟。请明确选择调整交付范围或可用时间，并重新核算可行性；如需修改目标期限，须先经过契约审批。不能保证任一选择必然可行，也不会自动修改目标。";
  expect(capacityRefusalMatches(reply, capacity)).toBe(true);
  for (const wrong of ["草案已保存", reply.replace("680分钟", "780分钟"),
    reply + "保持验收不变并把持久化移到期限之后即可。", ""]) {
    expect(capacityRefusalMatches(wrong, capacity)).toBe(false);
  }
  expect(capacityRefusalMatches(reply, { ...capacity, estimatedRemainingMinutes: NaN })).toBe(false);
});

it("requires exact current-plan numbers and all-zero tool telemetry for the separate conflict path", () => {
  const capacity = { estimatedRemainingMinutes: 484, proposedUnfinishedMinutes: 900 };
  const reply = "本轮尚未生成重规划草案：当前未完成估时900分钟，剩余估算可用484分钟，按当前估时有416分钟缺口。你希望先调整可用时间，还是通过界面审阅目标范围或期限变更？目标契约不会自动修改，调整后仍需重新核算。";
  expect(currentCapacityRefusalMatches(reply, capacity, [0])).toBe(true);
  for (const counts of [[], [undefined], [1], [0, 1], [0, undefined], [NaN]])
    expect(currentCapacityRefusalMatches(reply, capacity, counts)).toBe(false);
  for (const wrong of ["目前无法生成草案。", "Internal planning draft\n" + reply, reply + "草案已保存", reply.replace("416", "500")])
    expect(currentCapacityRefusalMatches(wrong, capacity, [0])).toBe(false);
  for (const available of [null, NaN, 900, 901, -1])
    expect(currentCapacityRefusalMatches(reply, { ...capacity, estimatedRemainingMinutes: available }, [0])).toBe(false);
});

it("sends full intake on the first contract turn and replays without another model request", async () => {
  const requests: ModelRequest[] = [];
  const turns: { message: string; operationId: string }[] = [];
  const now = new Date();
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario: "learning",
    now, outputDir: outputDir(), mockRequestObserver: request => requests.push(request),
    mockTurnObserver: turn => turns.push(turn) });
  expect(summary.passed).toBe(1);
  const scenario = lifecycleScenarios(now)[0];
  const firstUserContent = requests[0].messages.filter(message => message.role === "user").at(-1)?.content;
  const fullMessage = `${scenario.intake}\n${scenario.contractPrompt}`;
  expect(firstUserContent).toContain(fullMessage);
  expect(turns.slice(0, 2).map(turn => turn.message)).toEqual([fullMessage, fullMessage]);
  expect(turns[0].operationId).toBe(turns[1].operationId);
  const result = JSON.parse(readFileSync(summary.resultFiles[0], "utf8"));
  const contract = result.stages.find((stage: { name: string }) => stage.name === "contract_draft");
  expect(contract.invariants.replayProviderCallsUnchanged).toBe(true);
  expect(contract.providerCalls.length).toBe(2);
  const blockerRequest = requests.find(request => request.messages.filter(message => message.role === "user").at(-1)?.content === scenario.blockerPrompt);
  expect(blockerRequest).toBeDefined();
  const serializedFacts = blockerRequest!.messages.find(message => message.role === "system"
    && message.content.startsWith("以下是服务器读取的上下文数据"))!.content;
  const facts = JSON.parse(serializedFacts.slice(serializedFacts.indexOf("{")));
  const blocker = facts.recentCheckIns.findLast((item: { kind: string }) => item.kind === "blocker");
  expect(blocker).toMatchObject({ taskId: facts.currentTasks[1].id, taskTitle: facts.currentTasks[1].title,
    blockerCategory: "task_too_large" });
});

it("submits synthetic evidence matching every supported task evidence type through real services", async () => {
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario: "learning",
    outputDir: outputDir(), mockEvidenceTypes: ["file_metadata", "check_answer", "user_declaration"] });
  expect(summary.passed).toBe(1);
  const result = JSON.parse(readFileSync(summary.resultFiles[0], "utf8"));
  expect(result.stages.find((stage: { name: string }) => stage.name === "owner_export").exportContent.evidence.map((item: { type: string }) => item.type).sort())
    .toEqual(["check_answer", "file_metadata", "text", "user_declaration"].sort());
});

it("detects content and association tampering even when task and evidence counts stay equal", () => {
  const id = "00000000-0000-4000-8000-000000000001", nextId = "00000000-0000-4000-8000-000000000002";
  const evId = "00000000-0000-4000-8000-000000000003", copyId = "00000000-0000-4000-8000-000000000004";
  const dep1 = "00000000-0000-4000-8000-000000000005", dep2 = "00000000-0000-4000-8000-000000000006";
  const dep1Next = "00000000-0000-4000-8000-000000000007", dep2Next = "00000000-0000-4000-8000-000000000008";
  const task = { id, title: "结果", action: "执行", doneCriteria: "可核对", evidenceType: "file_metadata", estimateMinutes: 10,
    dueAt: null, dependencyIds: [dep1, dep2], status: "done", actualMinutes: 8 };
  const dependency = (key: string) => ({ ...task, id: key, status: "todo", actualMinutes: null, dependencyIds: [] });
  const evidence = { id: evId, taskId: id, goalId: id, type: "file_metadata", text: null,
    fileName: "synthetic.txt", fileSize: 42, mimeType: "text/plain" };
  const before = { goal: { id, version: 5, desiredOutcome: "成果" }, currentPlan: { id, version: 3 },
    tasks: [task, dependency(dep1), dependency(dep2)], evidence: [evidence] } as unknown as GoalWorkspace;
  const pending = { ...before, goal: { ...before.goal, version: 6 }, evidence: [{ ...evidence }] } as GoalWorkspace;
  expect(pendingReplanPreserved(before, pending)).toBe(true);
  expect(pendingReplanPreserved(before, { ...pending, tasks: [{ ...task, doneCriteria: "其他标准" }] } as unknown as GoalWorkspace)).toBe(false);
  expect(pendingReplanPreserved(before, { ...pending, evidence: [{ ...evidence, taskId: nextId }] } as unknown as GoalWorkspace)).toBe(false);
  const successor = { ...task, id: nextId, title: "新标题", estimateMinutes: 15, dueAt: "2026-10-30",
    dependencyIds: [dep2Next, dep1Next] };
  const copy = { ...evidence, id: copyId, taskId: nextId };
  const after = { ...pending, currentPlan: { id: nextId, version: 3 },
    tasks: [successor, dependency(dep1Next), dependency(dep2Next)], evidence: [copy] } as unknown as GoalWorkspace;
  const mapping = { taskMap: [
    { draftKey: id, sourceTaskId: id, storedTaskId: nextId },
    { draftKey: dep1, sourceTaskId: dep1, storedTaskId: dep1Next },
    { draftKey: dep2, sourceTaskId: dep2, storedTaskId: dep2Next },
  ],
    evidenceMap: [{ sourceEvidenceId: evId, copiedEvidenceId: copyId }], payload: { executionResets: [] } };
  expect(approvedReplanPreserved(before, after, mapping)).toBe(true);
  expect(approvedReplanPreserved(before, { ...after,
    tasks: [{ ...successor, action: "改变完成含义" }, ...after.tasks.slice(1)] } as GoalWorkspace, mapping)).toBe(false);
  expect(approvedReplanPreserved(before, { ...after,
    tasks: [{ ...successor, dependencyIds: [dep1Next] }, ...after.tasks.slice(1)] } as GoalWorkspace, mapping)).toBe(false);
  expect(approvedReplanPreserved(before, { ...after, evidence: [{ ...copy, fileSize: 43 }] } as unknown as GoalWorkspace, mapping)).toBe(false);
  expect(approvedReplanPreserved(before, { ...after, evidence: [{ ...copy, taskId: id }] } as unknown as GoalWorkspace, mapping)).toBe(false);
});

it("gates proposed unfinished due dates at the formal deadline without rejecting completed history", () => {
  const doneId = "00000000-0000-4000-8000-000000000011";
  const todoId = "00000000-0000-4000-8000-000000000012";
  const before = { goal: { deadline: "2026-10-11" }, tasks: [{ id: doneId, status: "done" },
    { id: todoId, status: "todo" }] } as GoalWorkspace;
  const payload = (dueAt: string | null) => ({ tasks: [{ id: doneId, dueAt: "2026-10-20" },
    { id: todoId, dueAt }] }) as Parameters<typeof proposedUnfinishedDuesWithinDeadline>[1];
  expect(proposedUnfinishedDuesWithinDeadline(before, payload("2026-10-12"))).toBe(false);
  expect(proposedUnfinishedDuesWithinDeadline(before, payload("2026-10-11"))).toBe(true);
  expect(proposedUnfinishedDuesWithinDeadline(before, payload(null))).toBe(true);
});

it("independently gates proposed unfinished estimates against latest active Shanghai capacity", () => {
  const ids = ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012",
    "00000000-0000-4000-8000-000000000013"];
  const before = { goal: { deadline: "2026-09-28", weeklyMinutes: 180 },
    tasks: ids.map((id, index) => ({ id, status: index === 0 ? "done" : index === 1 ? "skipped" : "todo" })),
    checkIns: [{ kind: "availability_change", availableWeeklyMinutes: 90, withdrawnAt: null }],
    effectiveCheckIns: [{ kind: "availability_change", availableWeeklyMinutes: 90, withdrawnAt: null }] } as GoalWorkspace;
  const task = (id: string, estimateMinutes: number) => ({ id, estimateMinutes });
  const payload = (remaining: number, executionResets: { taskKey: string; reason: "completion_meaning_changed" }[] = []) => ({
    tasks: [task(ids[0], 600), task(ids[1], 60), task(ids[2], remaining)], executionResets,
  }) as Parameters<typeof proposedUnfinishedWithinCapacity>[1];
  const now = new Date("2026-09-21T15:59:59.999Z");
  expect(proposedUnfinishedWithinCapacity(before, payload(90), now)).toEqual({
    withinCapacity: true, estimatedRemainingMinutes: 90, proposedUnfinishedMinutes: 90,
  });
  expect(proposedUnfinishedWithinCapacity(before, payload(91), now).withinCapacity).toBe(false);
  expect(proposedUnfinishedWithinCapacity(before, payload(40, [{ taskKey: ids[1], reason: "completion_meaning_changed" }]), now))
    .toMatchObject({ withinCapacity: false, proposedUnfinishedMinutes: 100 });
  expect(proposedUnfinishedWithinCapacity(before, payload(1), new Date("2026-09-28T16:00:00Z")))
    .toMatchObject({ withinCapacity: false, estimatedRemainingMinutes: 0 });
});

it("checks raw non-withdrawn availability even when task-associated feedback is absent from the projection", () => {
  const id = "00000000-0000-4000-8000-000000000021";
  const older = { kind: "availability_change", taskId: null, availableWeeklyMinutes: 180, withdrawnAt: null };
  const taskLinked = { kind: "availability_change", taskId: id, availableWeeklyMinutes: 90, withdrawnAt: null };
  const withdrawn = { kind: "availability_change", taskId: null, availableWeeklyMinutes: 30,
    withdrawnAt: "2026-09-21T00:00:00Z" };
  const before = { goal: { deadline: "2026-09-28", weeklyMinutes: 180 },
    tasks: [{ id, status: "todo" }], checkIns: [older, taskLinked, withdrawn], effectiveCheckIns: [older] } as GoalWorkspace;
  const payload = { tasks: [{ id, estimateMinutes: 100 }], executionResets: [] } as unknown as
    Parameters<typeof proposedUnfinishedWithinCapacity>[1];
  expect(proposedUnfinishedWithinCapacity(before, payload, new Date("2026-09-21T15:59:59.999Z")))
    .toEqual({ withinCapacity: false, estimatedRemainingMinutes: 90, proposedUnfinishedMinutes: 100 });
});

it("independently rejects saved replan drafts that lower an exact unchanged unfinished job", () => {
  const old = { id: "00000000-0000-4000-8000-000000000031", status: "doing", action: "整理三份样本",
    doneCriteria: "三份可检索", estimateMinutes: 90 };
  const before = { tasks: [old] } as GoalWorkspace;
  const payload = (tasks: object[]) => ({ tasks }) as Parameters<typeof proposedUnchangedWorkEstimatesPreserved>[1];
  expect(proposedUnchangedWorkEstimatesPreserved(before, payload([{ ...old, title: "改名", estimateMinutes: 60 }]))).toBe(false);
  expect(proposedUnchangedWorkEstimatesPreserved(before, payload([{ ...old, id: "00000000-0000-4000-8000-000000000032",
    estimateMinutes: 60 }]))).toBe(false);
  expect(proposedUnchangedWorkEstimatesPreserved(before, payload([{ ...old, action: "用固定模板整理三份样本",
    estimateMinutes: 60 }]))).toBe(true);
  expect(proposedUnchangedWorkEstimatesPreserved({ tasks: [{ ...old, status: "skipped" }] } as GoalWorkspace,
    payload([{ ...old, estimateMinutes: 60 }]))).toBe(true);
  expect(proposedUnchangedWorkEstimatesPreserved({ tasks: [old, { ...old, id: "00000000-0000-4000-8000-000000000033" }] } as GoalWorkspace,
    payload([{ ...old, id: "00000000-0000-4000-8000-000000000032", estimateMinutes: 60 }]))).toBe(true);
});

it("captures a failed pre-stage workspace read and refuses a passing terminal result", async () => {
  const summary = await runLifecycleEvaluation({ provider: "mock", allowLive: false, scenario: "learning",
    outputDir: outputDir(), mockReadFailureAtStage: "consent" });
  expect(summary).toMatchObject({ passed: 0, failed: 1 });
  const result = JSON.parse(readFileSync(summary.resultFiles[0], "utf8"));
  expect(result.stages.at(-1)).toMatchObject({ name: "consent", passed: false, error: { code: expect.any(String) } });
  expect(result.stages.some((stage: { name: string }) => stage.name === "owner_export")).toBe(false);
});
