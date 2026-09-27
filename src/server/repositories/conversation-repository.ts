import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ConversationMessage } from "@/core/domain/contracts";
import * as tables from "../db/schema";
import type { ConversationRepository, SyncRepository } from "./repository-types";
import { ConversationMessageCreateInputSchema, ConversationSummaryInputSchema } from "./repository-inputs";
import { conflict, identity, type RepositoryContext } from "./repository-internals";
import { fencedConversation } from "./conversation-fence";
export function conversationOperations(ctx: RepositoryContext): SyncRepository<ConversationRepository> {
  const summarySnapshotSchema = z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    throughMessageId: z.string().uuid(),
  }).strict();
  const compareAndReplaceSchema = ConversationSummaryInputSchema.extend({
    expectedSummary: summarySnapshotSchema.nullable(),
    expectedFenceRevision: z.number().int().nonnegative(),
  }).strict();
  const summary = (owner: string, goalId: string) =>
    ctx.stores.summaries.list(owner, eq(tables.conversationSummaries.goalId, goalId)).at(-1) ?? null;
  const boundaryIndex = (
    messages: ConversationMessage[],
    throughMessageId: string,
  ) => messages.findIndex(message => message.id === throughMessageId);
  return {
    append(owner, goalId, input) {
      ctx.requireGoal(owner, goalId);
      return ctx.stores.messages.create(owner, {
        ...ConversationMessageCreateInputSchema.parse(input), goalId
      });
    },
    last(owner, goalId, limit) {
      identity(owner, goalId);
      z.number().int().min(1).max(1000).parse(limit);
      return ctx.stores.messages.list(owner, eq(tables.conversationMessages.goalId, goalId)).slice(-limit);
    },
    getSummary(owner, goalId) {
      identity(owner, goalId);
      return summary(owner, goalId);
    },
    getSnapshot(owner, goalId) {
      ctx.requireGoal(owner, goalId);
      const { messages, summary: current, fenceRevision, invalidSummary } = fencedConversation(ctx, owner, goalId);
      if (invalidSummary) conflict();
      if (!current)
        return { summary: null, unsummarizedMessages: messages, fenceRevision };
      const index = boundaryIndex(messages, current.throughMessageId);
      if (index < 0)
        conflict();
      return { summary: current, unsummarizedMessages: messages.slice(index + 1), fenceRevision };
    },
    replaceSummary(owner, goalId, input) {
      ctx.requireGoal(owner, goalId);
      const summary = ConversationSummaryInputSchema.parse(input);
      const message = ctx.stores.messages.get(owner, summary.throughMessageId);
      if (!message || message.goalId !== goalId)
        conflict();
      const active = fencedConversation(ctx, owner, goalId);
      if (!active.messages.some(row => row.id === summary.throughMessageId)) conflict();
      const old = active.summary;
      return old ? ctx.stores.summaries.update(owner, old.id, old.version, summary) : ctx.stores.summaries.create(owner, {
        ...summary, goalId
      });
    },
    replaceSummaryIfSnapshotMatches(owner, goalId, input) {
      identity(owner, goalId);
      const value = compareAndReplaceSchema.parse(input);
      if (!ctx.stores.goals.get(owner, goalId))
        return null;
      const active = fencedConversation(ctx, owner, goalId);
      if (active.invalidSummary || value.expectedFenceRevision !== active.fenceRevision) return null;
      const current = active.summary;
      if (value.expectedSummary === null ? current !== null : !current
        || (current && value.expectedSummary && (
          current.id !== value.expectedSummary.id
          || current.version !== value.expectedSummary.version
          || current.throughMessageId !== value.expectedSummary.throughMessageId
        )))
        return null;
      const messages = active.messages;
      const oldBoundary = current ? boundaryIndex(messages, current.throughMessageId) : -1;
      const nextBoundary = boundaryIndex(messages, value.throughMessageId);
      if ((current && oldBoundary < 0) || nextBoundary <= oldBoundary)
        return null;
      const replacement = ConversationSummaryInputSchema.parse({
        throughMessageId: value.throughMessageId,
        content: value.content,
      });
      return current
        ? ctx.stores.summaries.update(owner, current.id, current.version, replacement)
        : ctx.stores.summaries.create(owner, { ...replacement, goalId });
    },
  };
}
