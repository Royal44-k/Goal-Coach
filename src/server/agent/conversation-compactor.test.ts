import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/core/domain/contracts";
import { createDatabase, type AppDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { createRepositories } from "../repositories/repository-factory";
import type { ModelRequest, ModelTurn } from "./model-contracts";
import { compactConversationIfNeeded } from "./conversation-compactor";

const ownerId = "00000000-0000-4000-8000-000000000001";
const model = "qwen3.7-flash-2026-07-15";
let database: AppDatabase;
let repositories: ReturnType<typeof createRepositories>;
let goalId: string;

beforeEach(async () => {
  database = createDatabase(":memory:");
  migrateDatabase(database);
  repositories = createRepositories(database);
  const goal = await repositories.goals.create(ownerId, {
    title: "练习 TypeScript", category: "learning", desiredOutcome: null,
    definitionOfDone: null, deadline: null, weeklyMinutes: null, constraints: null, motivation: null,
  });
  goalId = goal.id;
});
afterEach(() => database?.$client.close());

async function appendMessages(count: number, prefix = "M") {
  const messages: ConversationMessage[] = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push(await repositories.conversations.append(ownerId, goalId, {
      role: index % 2 === 1 ? "user" : "assistant",
      content: `[${prefix}${String(index).padStart(2, "0")}]`,
    }));
  }
  return messages;
}

const turn = (text: string, overrides: Partial<ModelTurn> = {}): ModelTurn => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 100, outputTokens: 20 },
  finishReason: "stop",
  ...overrides,
});

describe("compactConversationIfNeeded", () => {
  it("summarizes every earlier unsummarized message through message 7 and keeps the latest 6 verbatim", async () => {
    const originalGoal = await repositories.goals.get(ownerId, goalId);
    const oldMessages = await appendMessages(2, "OLD");
    await repositories.conversations.replaceSummary(ownerId, goalId, {
      throughMessageId: oldMessages[1].id,
      content: "已有摘要：用户选择晚间学习。",
    });
    const messages = await appendMessages(13);
    let capturedRequest: ModelRequest | undefined;

    const result = await compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async (request) => {
        capturedRequest = request;
        return turn("决定：保持晚间学习。约束：每次三十分钟。未决问题：无。可见结果：已完成前七轮。 ");
      },
    });

    expect(result).toMatchObject({ status: "compacted", summary: { throughMessageId: messages[6].id } });
    expect(capturedRequest).toMatchObject({ model, tools: [] });
    expect(capturedRequest?.messages).toHaveLength(2);
    expect(capturedRequest?.messages[0]).toMatchObject({ role: "system" });
    const summaryInput = capturedRequest?.messages[1]?.content ?? "";
    expect(summaryInput).toContain("已有摘要：用户选择晚间学习。");
    for (let index = 1; index <= 7; index += 1)
      expect(summaryInput).toContain(`[M${String(index).padStart(2, "0")}]`);
    for (let index = 8; index <= 13; index += 1)
      expect(summaryInput).not.toContain(`[M${String(index).padStart(2, "0")}]`);
    const snapshot = await repositories.conversations.getSnapshot(ownerId, goalId);
    expect(snapshot.unsummarizedMessages.map(message => message.content)).toEqual([
      "[M08]", "[M09]", "[M10]", "[M11]", "[M12]", "[M13]",
    ]);
    expect(await repositories.conversations.last(ownerId, goalId, 1000)).toHaveLength(15);
    expect(snapshot.summary?.content).not.toContain("思维过程");
    expect(await repositories.goals.get(ownerId, goalId)).toEqual(originalGoal);
  });

  it("does not call the model at the twelve-message threshold", async () => {
    await appendMessages(12);
    let called = false;
    const result = await compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async () => {
        called = true;
        return turn("不应生成");
      },
    });
    expect(result).toEqual({ status: "not_needed", summary: null });
    expect(called).toBe(false);
  });

  it("loads complete insertion order beyond the legacy last-message cap", async () => {
    await repositories.withTransaction(tx => {
      for (let index = 1; index <= 1001; index += 1) {
        tx.conversations.append(ownerId, goalId, {
          role: index % 2 === 1 ? "user" : "assistant",
          content: `[LONG${String(index).padStart(4, "0")}]`,
        });
      }
    });
    let receivedMessages: Array<{ role: string; content: string }> = [];

    const result = await compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async (request) => {
        receivedMessages = JSON.parse(request.messages[1].content).messages;
        return turn("长对话摘要");
      },
    });

    expect(result.status).toBe("compacted");
    expect(receivedMessages).toHaveLength(995);
    expect(receivedMessages[0].content).toBe("[LONG0001]");
    expect(receivedMessages[994].content).toBe("[LONG0995]");
    expect((await repositories.conversations.getSnapshot(ownerId, goalId)).unsummarizedMessages
      .map(message => message.content)).toEqual([
        "[LONG0996]", "[LONG0997]", "[LONG0998]", "[LONG0999]", "[LONG1000]", "[LONG1001]",
      ]);
  });

  it("uses insertion order when messages have identical timestamps", async () => {
    const messages = await appendMessages(13, "SAME");
    database.$client.prepare("UPDATE conversation_messages SET created_at = ?, updated_at = ? WHERE goal_id = ?")
      .run(1_800_000_000_000, 1_800_000_000_000, goalId);
    let received: Array<{ role: string; content: string }> = [];

    const result = await compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async (request) => {
        received = JSON.parse(request.messages[1].content).messages;
        return turn("同一时间消息仍按写入顺序压缩");
      },
    });

    expect(received.map(message => message.content)).toEqual([
      "[SAME01]", "[SAME02]", "[SAME03]", "[SAME04]", "[SAME05]", "[SAME06]", "[SAME07]",
    ]);
    expect(result).toMatchObject({ status: "compacted", summary: { throughMessageId: messages[6].id } });
  });

  it.each([
    ["model failure", async () => { throw new Error("provider unavailable"); }],
    ["blank summary", async () => turn("   ")],
    ["oversized summary", async () => turn("长".repeat(1501))],
    ["unexpected tool response", async () => turn("", { toolCalls: [{ id: "call-1", name: "get_goal", argumentsJson: "{}" }] })],
  ])("keeps the old boundary after %s", async (_name, callModel) => {
    const oldMessages = await appendMessages(1, "OLD");
    const oldSummary = await repositories.conversations.replaceSummary(ownerId, goalId, {
      throughMessageId: oldMessages[0].id,
      content: "原摘要",
    });
    await appendMessages(13);

    const result = await compactConversationIfNeeded({ ownerId, goalId, model, repositories, callModel });

    expect(result.status).toBe("skipped");
    expect(await repositories.conversations.getSummary(ownerId, goalId)).toEqual(oldSummary);
  });

  it("does not let an older async result replace a newer summary boundary", async () => {
    const messages = await appendMessages(13);
    let release!: (value: ModelTurn) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const pendingTurn = new Promise<ModelTurn>(resolve => { release = resolve; });
    const pending = compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async () => {
        started();
        return pendingTurn;
      },
    });
    await began;
    const snapshot = await repositories.conversations.getSnapshot(ownerId, goalId);
    const newer = await repositories.conversations.replaceSummaryIfSnapshotMatches(ownerId, goalId, {
      expectedSummary: null, expectedFenceRevision: 0,
      throughMessageId: messages[7].id,
      content: "较新的摘要",
    });
    expect(newer).not.toBeNull();
    release(turn("迟到的旧摘要"));

    await expect(pending).resolves.toMatchObject({ status: "skipped", reason: "stale_snapshot" });
    expect((await repositories.conversations.getSummary(ownerId, goalId))?.content).toBe("较新的摘要");
    expect(snapshot.unsummarizedMessages).toHaveLength(13);
  });

  it("allows a captured safe prefix when a newer message is appended during the model call", async () => {
    const messages = await appendMessages(13);
    let release!: (value: ModelTurn) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const pendingTurn = new Promise<ModelTurn>(resolve => { release = resolve; });
    const pending = compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async () => {
        started();
        return pendingTurn;
      },
    });
    await began;
    await repositories.conversations.append(ownerId, goalId, { role: "user", content: "[M14]" });
    release(turn("安全前缀摘要"));

    await expect(pending).resolves.toMatchObject({
      status: "compacted",
      summary: { throughMessageId: messages[6].id },
    });
    expect((await repositories.conversations.getSnapshot(ownerId, goalId)).unsummarizedMessages
      .map(message => message.content)).toEqual([
        "[M08]", "[M09]", "[M10]", "[M11]", "[M12]", "[M13]", "[M14]",
      ]);
  });

  it("does not recreate content after the goal is deleted during the model call", async () => {
    await appendMessages(13);
    let release!: (value: ModelTurn) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const pendingTurn = new Promise<ModelTurn>(resolve => { release = resolve; });
    const pending = compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async () => {
        started();
        return pendingTurn;
      },
    });
    await began;
    await repositories.goals.delete(ownerId, goalId);
    release(turn("不应写回"));

    await expect(pending).resolves.toMatchObject({ status: "skipped", reason: "stale_snapshot" });
    expect(await repositories.goals.get(ownerId, goalId)).toBeNull();
    expect(await repositories.conversations.getSummary(ownerId, goalId)).toBeNull();
  });

  it("does not recreate content after all owner data is cleared during the model call", async () => {
    await appendMessages(13);
    let release!: (value: ModelTurn) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const pendingTurn = new Promise<ModelTurn>(resolve => { release = resolve; });
    const pending = compactConversationIfNeeded({
      ownerId, goalId, model, repositories,
      callModel: async () => {
        started();
        return pendingTurn;
      },
    });
    await began;
    const operation = await repositories.support.createOperation(ownerId, {
      goalId: null,
      operationId: "clear:compaction",
      toolName: "clear_all_data",
      parameterHash: "a".repeat(64),
    });
    await repositories.withTransaction(tx => {
      tx.support.clearOwnerData(ownerId, operation.id);
      tx.support.updateOperation(ownerId, operation.id, operation.version, {
        status: "succeeded",
        result: { cleared: true },
      });
    });
    release(turn("不应在清除后写回"));

    await expect(pending).resolves.toMatchObject({ status: "skipped", reason: "stale_snapshot" });
    expect(await repositories.goals.list(ownerId)).toEqual([]);
    expect(await repositories.conversations.getSummary(ownerId, goalId)).toBeNull();
  });

  it("fails safely when a stored summary boundary no longer identifies a message", async () => {
    const messages = await appendMessages(13);
    const summary = await repositories.conversations.replaceSummary(ownerId, goalId, {
      throughMessageId: messages[0].id,
      content: "原摘要",
    });
    database.$client.pragma("foreign_keys = OFF");
    database.$client.prepare("UPDATE conversation_summaries SET through_message_id = ? WHERE id = ?")
      .run("00000000-0000-4000-8000-000000000099", summary.id);
    database.$client.pragma("foreign_keys = ON");

    await expect(repositories.conversations.getSnapshot(ownerId, goalId)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    await expect(repositories.conversations.replaceSummaryIfSnapshotMatches(ownerId, goalId, {
      expectedFenceRevision: 0, expectedSummary: {
        id: summary.id,
        version: summary.version,
        throughMessageId: "00000000-0000-4000-8000-000000000099",
      },
      throughMessageId: messages[6].id,
      content: "不得写入",
    })).resolves.toBeNull();
  });
});
