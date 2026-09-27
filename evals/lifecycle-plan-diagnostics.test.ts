import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TaskCreateInputSchema } from "@/server/repositories/revision-contracts";
import type { GoalWorkspace } from "@/server/services/service-contracts";
import { diagnoseLifecyclePlanCall } from "./lifecycle-plan-diagnostics";

const task = () => ({ id: randomUUID(), title: "合成任务", action: "完成合成步骤",
  doneCriteria: "保存合成结果", evidenceType: "text" as const, estimateMinutes: 20,
  dueAt: null, dependencyIds: [] as string[] });
function fixture(count: number, current = false) {
  const planId = randomUUID();
  const goal = { id: randomUUID(), version: current ? 8 : 2, currentPlanVersionId: current ? planId : null };
  const existing = current ? Array.from({ length: count }, task).map(item => ({
    ...item, ownerId: randomUUID(), goalId: goal.id, planVersionId: planId, status: "todo" as const,
    actualMinutes: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
  })) : [];
  const proposed = current ? existing.map(item => TaskCreateInputSchema.strip().parse(item)) : Array.from({ length: count }, task);
  const workspace = { goal, currentPlan: current ? { id: planId, version: 3, milestones: ["合成里程碑"] } : null,
    tasks: existing } as unknown as GoalWorkspace;
  const payload = { base: { goalVersion: goal.version, planVersionId: goal.currentPlanVersionId },
    milestones: ["合成里程碑"], changeReason: current ? "合成调整" : null, tasks: proposed };
  return { workspace, payload };
}
function call(name: "create_plan_draft" | "propose_replan", args: unknown) {
  return { id: "synthetic-call", name, argumentsJson: JSON.stringify(args) };
}

it("rejects a nine-task proposal at the model boundary", () => {
  const { workspace, payload } = fixture(9);
  expect(diagnoseLifecyclePlanCall(call("create_plan_draft", { goalId: workspace.goal.id, payload }), workspace))
    .toMatchObject({ status: "invalid_arguments", taskCount: null });
});

it("rejects model-supplied canonical metadata without exposing task values", () => {
  const { workspace, payload } = fixture(3);
  const changed = { ...payload, diff: { added: [] } };
  expect(diagnoseLifecyclePlanCall(call("create_plan_draft", { goalId: workspace.goal.id, payload: changed }), workspace))
    .toMatchObject({ status: "invalid_arguments", taskCount: null });
});

it("identifies a no-change replan despite valid arguments and task count", () => {
  const { workspace, payload } = fixture(3, true);
  expect(diagnoseLifecyclePlanCall(call("propose_replan", { goalId: workspace.goal.id, payload }), workspace))
    .toMatchObject({ status: "valid", taskCount: 3, withinTaskRange: true,
      baseGoalVersionMatches: true, basePlanVersionMatches: true,
      canonicalDiffDerived: true, canonicalExecutionResetsDerived: true, hasPlanChange: false });
});

it("marks invalid JSON and unknown fields without retaining their names or values", () => {
  const { workspace, payload } = fixture(3);
  const broken = diagnoseLifecyclePlanCall({ id: "synthetic-call", name: "propose_replan", argumentsJson: "{" }, workspace);
  expect(broken).toMatchObject({ status: "invalid_json", taskCount: null });
  const extra = diagnoseLifecyclePlanCall(call("propose_replan", { goalId: workspace.goal.id, payload, privateSecret: "SHOULD_NEVER_APPEAR" }), workspace);
  expect(extra).toMatchObject({ status: "invalid_arguments", taskCount: null });
  expect(JSON.stringify(extra)).not.toContain("privateSecret");
  expect(JSON.stringify(extra)).not.toContain("SHOULD_NEVER_APPEAR");
});
