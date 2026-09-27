"use client";

import { useMemo, useState } from "react";
import type { ConversationMessage } from "@/core/domain/contracts";
import { useAgentTurn } from "./use-agent-turn";

type VisibleMessage = Pick<ConversationMessage, "id" | "role" | "content">;

export function AgentChat({
  goalId,
  initialMessages,
  onRefresh,
  freshRequestsDisabled = false,
}: {
  goalId: string;
  initialMessages: readonly VisibleMessage[];
  onRefresh: () => Promise<void>;
  freshRequestsDisabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [responses, setResponses] = useState<string[]>([]);
  const turn = useAgentTurn(goalId, onRefresh, async result => {
    setResponses(previous => [...previous, result.message]);
    await onRefresh();
  });

  const visibleResponses = useMemo(() => {
    const authoritativeCounts = new Map<string, number>();
    for (const message of initialMessages) {
      if (message.role === "assistant") {
        authoritativeCounts.set(message.content, (authoritativeCounts.get(message.content) ?? 0) + 1);
      }
    }
    return responses.filter(message => {
      const count = authoritativeCounts.get(message) ?? 0;
      if (count === 0) return true;
      authoritativeCounts.set(message, count - 1);
      return false;
    });
  }, [initialMessages, responses]);

  async function submit() {
    if (freshRequestsDisabled) return;
    const submitted = text.trim();
    const result = await turn.send(submitted);
    if (result) setText(previous => previous.trim() === submitted ? "" : previous);
  }

  async function sendNew() {
    if (freshRequestsDisabled) return;
    const submitted = text.trim() || turn.request?.message || "";
    const result = await turn.sendNew(submitted);
    if (result) setText(previous => previous.trim() === submitted ? "" : previous);
  }

  async function retryRefresh() {
    await turn.refresh();
  }

  const freshSendLocked = freshRequestsDisabled || turn.phase !== "idle";
  const receivedAlert = turn.receivedErrorCode === "MODEL_TIMEOUT"
    ? turn.phase === "received_reconciled"
      ? "模型响应超时，已进入手动恢复模式。请使用当前页面实际可用的手动操作，或显式发送新一轮。"
      : turn.phase === "refresh_failed"
        ? "模型响应超时，且目标状态读取失败。请先重新读取目标状态；确认完成前请勿发起新操作。"
        : "模型响应超时；正在重新读取目标状态。确认完成前请勿发起新操作。"
    : "服务已返回结果，但无法判断上一轮是否执行。请以重新读取的目标状态为准。";

  return (
    <section className="agent-chat" aria-labelledby="agent-chat-title">
      <h2 id="agent-chat-title">和教练澄清目标</h2>
      <ol className="conversation" aria-label="目标对话">
        {initialMessages.map(message => (
          <li key={message.id}>
            <strong>{message.role === "user" ? "你" : "教练"}</strong>
            <p>{message.content}</p>
          </li>
        ))}
        {visibleResponses.map((message, index) => (
          <li key={`${index}-${message}`}><strong>教练</strong><p>{message}</p></li>
        ))}
      </ol>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label htmlFor={`agent-message-${goalId}`}>告诉教练你的目标</label>
        <textarea
          id={`agent-message-${goalId}`}
          value={text}
          onChange={event => setText(event.target.value)}
          disabled={turn.phase === "running"}
        />
        <button type="submit" disabled={freshSendLocked || !text.trim()}>
          {turn.phase === "running" ? "正在发送…" : "发送"}
        </button>
      </form>
      {turn.phase === "unknown_outcome" ? (
        <div className="recovery-panel">
          <p role="alert">无法确认本次请求是否完成。查询会使用同一请求编号，不会创建新一轮。</p>
          <button type="button" onClick={() => void turn.lookup()}>查询本次结果</button>
          <button type="button" onClick={() => void turn.refresh()}>重新读取目标状态</button>
        </div>
      ) : null}
      {turn.phase === "received_needs_refresh" || turn.phase === "received_reconciled" || turn.phase === "refresh_failed" ? (
        <div className="recovery-panel">
          <p role="alert">{receivedAlert}</p>
          {turn.phase === "received_reconciled" ? (
            <>
              <p>发送新一轮可能执行新的工作，请确认后再继续。</p>
              <button type="button" disabled={freshRequestsDisabled} onClick={() => void sendNew()}>发送新一轮</button>
            </>
          ) : null}
          {turn.phase === "refresh_failed" ? (
            <>
              <button type="button" onClick={() => void retryRefresh()}>重新读取目标状态</button>
              <button type="button" onClick={() => void turn.lookup()}>查询本次结果</button>
            </>
          ) : null}
        </div>
      ) : null}
      {turn.phase === "success_refresh_failed" ? (
        <div className="recovery-panel">
          <p role="alert">本轮回复已经收到，但重新读取目标状态失败。</p>
          <button type="button" onClick={() => void retryRefresh()}>重新读取目标状态</button>
        </div>
      ) : null}
    </section>
  );
}
