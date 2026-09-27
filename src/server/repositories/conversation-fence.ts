import { eq } from "drizzle-orm";
import * as tables from "../db/schema";
import { conflict, type RepositoryContext } from "./repository-internals";

export function fencedConversation(ctx: RepositoryContext, owner: string, goalId: string) {
  const messages = ctx.stores.messages.list(owner, eq(tables.conversationMessages.goalId, goalId));
  const fences = ctx.stores.undos.list(owner, eq(tables.undoRecords.goalId, goalId)).flatMap(row => row.undoneAt && row.conversationFence ? [row.conversationFence] : []);
  const fence = fences.sort((a, b) => a.revision - b.revision).at(-1);
  const boundary = fence?.throughMessageId ? messages.findIndex(row => row.id === fence.throughMessageId) : -1;
  if (fence?.throughMessageId && boundary < 0) conflict();
  const activeMessages = messages.slice(boundary + 1);
  const ids = new Set(activeMessages.map(row => row.id));
  const summaries = ctx.stores.summaries.list(owner, eq(tables.conversationSummaries.goalId, goalId));
  const allIds = new Set(messages.map(row => row.id));
  const invalidSummary = summaries.some(row => !allIds.has(row.throughMessageId));
  const summary = summaries.filter(row => ids.has(row.throughMessageId)).at(-1) ?? null;
  return { messages: activeMessages, summary, fenceRevision: fence?.revision ?? 0, invalidSummary };
}
