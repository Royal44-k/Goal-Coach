import { z } from "zod";
import type { ConversationSummary } from "@/core/domain/contracts";
import type { Repositories, RepositoryUnitOfWork } from "../repositories/repository-types";
import { ModelRequestSchema, ModelTurnSchema, type ModelRequest, type ModelTurn } from "./model-contracts";

const MAX_UNSUMMARIZED_MESSAGES = 12;
const RETAINED_MESSAGES = 6;
const SummaryTextSchema = z.string().trim().min(1).max(1500);
const SUMMARY_SYSTEM_MESSAGE = "你只负责压缩可见对话。仅保留用户决定、约束、未解决问题和用户可见结果；不要添加建议、秘密、工具协议或隐藏思维过程。摘要不超过1500个字符。";

export type BudgetedModelCall = (request: ModelRequest) => Promise<ModelTurn>;
export type ConversationCompactionResult =
  | { status: "not_needed"; summary: ConversationSummary | null }
  | { status: "compacted"; summary: ConversationSummary }
  | {
    status: "skipped";
    reason: "model_unavailable" | "invalid_summary" | "stale_snapshot";
    summary: ConversationSummary | null;
  };

export async function compactConversationIfNeeded(input: {
  ownerId: string;
  goalId: string;
  model: string;
  repositories: Repositories & RepositoryUnitOfWork;
  callModel: BudgetedModelCall;
}): Promise<ConversationCompactionResult> {
  const snapshot = await input.repositories.conversations.getSnapshot(input.ownerId, input.goalId);
  if (snapshot.unsummarizedMessages.length <= MAX_UNSUMMARIZED_MESSAGES)
    return { status: "not_needed", summary: snapshot.summary };

  const compactedMessages = snapshot.unsummarizedMessages.slice(0, -RETAINED_MESSAGES);
  const throughMessage = compactedMessages.at(-1)!;
  const summaryInput = {
    ...(snapshot.summary ? { existingSummary: snapshot.summary.content } : {}),
    messages: compactedMessages.map(({ role, content }) => ({ role, content })),
  };
  const request = ModelRequestSchema.parse({
    model: input.model,
    tools: [],
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_MESSAGE },
      { role: "user", content: JSON.stringify(summaryInput) },
    ],
  });

  let rawTurn: ModelTurn;
  try {
    rawTurn = await input.callModel(request);
  }
  catch {
    return { status: "skipped", reason: "model_unavailable", summary: snapshot.summary };
  }
  const parsedTurn = ModelTurnSchema.safeParse(rawTurn);
  if (!parsedTurn.success || parsedTurn.data.toolCalls.length !== 0)
    return { status: "skipped", reason: "invalid_summary", summary: snapshot.summary };
  const parsedText = SummaryTextSchema.safeParse(parsedTurn.data.text);
  if (!parsedText.success)
    return { status: "skipped", reason: "invalid_summary", summary: snapshot.summary };

  const saved = await input.repositories.conversations.replaceSummaryIfSnapshotMatches(
    input.ownerId,
    input.goalId,
    {
      expectedFenceRevision: snapshot.fenceRevision,
      expectedSummary: snapshot.summary ? {
        id: snapshot.summary.id,
        version: snapshot.summary.version,
        throughMessageId: snapshot.summary.throughMessageId,
      } : null,
      throughMessageId: throughMessage.id,
      content: parsedText.data,
    },
  );
  return saved
    ? { status: "compacted", summary: saved }
    : { status: "skipped", reason: "stale_snapshot", summary: snapshot.summary };
}
