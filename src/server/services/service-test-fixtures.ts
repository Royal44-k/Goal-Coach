import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createServiceContainer } from "./service-container";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { LOCAL_TYPESCRIPT_INPUT, LOCAL_TYPESCRIPT_DONE } from "../agent/local-mock-model-client";
const owner = LOCAL_OWNER_ID;

export async function approvedGoal(services: ReturnType<typeof createServiceContainer>) {
  const { goal } = await services.goals.create(owner, { category: "learning", initialMessage: LOCAL_TYPESCRIPT_INPUT });
  const turn = (message: string) => services.agent.processTurn(owner, { goalId: goal.id, message, requestOperationId: randomUUID() });
  const question = await turn(LOCAL_TYPESCRIPT_INPUT);
  expect(question.message).toContain("完成标准");
  const contractResult = await turn(LOCAL_TYPESCRIPT_DONE);
  const contractDraft = (await services.goals.getWorkspace(owner, goal.id)).pendingDrafts.find(d => d.id === contractResult.draftId)!;
  await services.approvals.approve(owner, { goalId: goal.id, draftId: contractDraft.id, expectedDraftVersion: contractDraft.version, toolName: "save_approved_contract", operationId: randomUUID() });
  const planResult = await turn("生成计划");
  const planDraft = (await services.goals.getWorkspace(owner, goal.id)).pendingDrafts.find(d => d.id === planResult.draftId)!;
  await services.approvals.approve(owner, { goalId: goal.id, draftId: planDraft.id, expectedDraftVersion: planDraft.version, toolName: "save_approved_plan", operationId: randomUUID() });
  return services.goals.getWorkspace(owner, goal.id);
}
export function executionInput(w: Awaited<ReturnType<ReturnType<typeof createServiceContainer>["goals"]["getWorkspace"]>>, index = 0) {
  return { goalId: w.goal.id, expectedVersion: w.tasks[index].version, expectedGoalVersion: w.goal.version, expectedPlanVersion: { id: w.currentPlan!.id, version: w.currentPlan!.version }, source: "ui_explicit" as const, operationId: randomUUID() };
}
