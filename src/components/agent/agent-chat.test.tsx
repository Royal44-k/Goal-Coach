// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentChat } from "./agent-chat";
import { useAgentTurn } from "./use-agent-turn";

const goalId = "40000000-0000-4000-8000-000000000001";
const operationId = "40000000-0000-4000-8000-000000000002";
const nextOperationId = "40000000-0000-4000-8000-000000000003";

const turnResult = {
  message: "你希望最终完成什么可展示的成果？",
  state: "clarifying",
  persistedChange: false,
  usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0 },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("submits one normalized turn and renders one accessible composer", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: turnResult })));

  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={vi.fn()} />);
  await user.type(screen.getByLabelText("告诉教练你的目标"), "  我想学习 TypeScript  ");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByText(turnResult.message)).toBeInTheDocument();
  expect(screen.queryAllByRole("textbox")).toHaveLength(1);
  expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({
    goalId,
    message: "我想学习 TypeScript",
    requestOperationId: operationId,
    explicitIntent: true,
  });
});

it("replays the exact same request id and text after an unknown outcome", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError("private network detail"))
    .mockResolvedValueOnce(Response.json({ ok: true, data: turnResult }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={vi.fn()} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "  保留这段文字  ");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.clear(screen.getByLabelText("告诉教练你的目标"));
  await user.type(screen.getByLabelText("告诉教练你的目标"), "后来编辑的文字");
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: "查询本次结果" }));

  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(bodies).toEqual([
    { goalId, message: "保留这段文字", requestOperationId: operationId, explicitIntent: true },
    { goalId, message: "保留这段文字", requestOperationId: operationId, explicitIntent: true },
  ]);
  expect(await screen.findByText(turnResult.message)).toBeInTheDocument();
});

it("refreshes after a received error without issuing a new turn", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "INVALID_TRANSITION", message: "私有服务细节" },
  }, { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("服务已返回结果，但无法判断上一轮是否执行");
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "发送新一轮" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
});

it("offers manual recovery after a timeout only once authoritative refresh succeeds", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" },
  }, { status: 504 })));
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("模型响应超时，已进入手动恢复模式");
  expect(screen.getByRole("button", { name: "发送新一轮" })).toBeEnabled();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it("uses a fresh id only after an explicit new-turn action", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(operationId)
    .mockReturnValueOnce(nextOperationId);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: false, error: { code: "INVALID_TRANSITION", message: "私有服务细节" } }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: turnResult }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={vi.fn().mockResolvedValue(undefined)} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "发送新一轮" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "发送新一轮" }));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).requestOperationId).toBe(nextOperationId);
});

it("blocks the explicit fresh-turn path when a goal-scoped mutation owns authority", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "INVALID_TRANSITION", message: "private" },
  }, { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={vi.fn().mockResolvedValue(undefined)} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("button", { name: "发送新一轮" })).toBeEnabled();

  view.rerender(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={vi.fn().mockResolvedValue(undefined)} freshRequestsDisabled />);
  const sendNewButton = screen.getByRole("button", { name: "发送新一轮" });
  expect(sendNewButton).toBeDisabled();
  await user.click(sendNewButton);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retains timeout context without promising manual actions when reconciliation fails", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const onRefresh = vi.fn().mockRejectedValue(new Error("private refresh detail"));
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" },
  }, { status: 504 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("模型响应超时，且目标状态读取失败");
  expect(screen.getByRole("alert")).toHaveTextContent("请先重新读取目标状态");
  expect(screen.getByRole("alert")).not.toHaveTextContent("手动恢复模式");
  expect(await screen.findByRole("button", { name: "重新读取目标状态" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "查询本次结果" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "发送新一轮" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("serializes same-id lookup behind a deferred refresh without stranding later recovery", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  let finishUnknownRefresh: (() => void) | undefined;
  const onRefresh = vi.fn()
    .mockImplementationOnce(() => new Promise<void>(resolve => { finishUnknownRefresh = resolve; }))
    .mockRejectedValueOnce(new Error("known-success refresh failed"))
    .mockResolvedValueOnce(undefined);
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError("lost initial response"))
    .mockResolvedValueOnce(Response.json({ ok: true, data: turnResult }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "  保留原始请求  ");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "查询本次结果" });

  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  await user.click(screen.getByRole("button", { name: "查询本次结果" }));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await act(async () => { finishUnknownRefresh?.(); });
  await user.click(screen.getByRole("button", { name: "查询本次结果" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("本轮回复已经收到，但重新读取目标状态失败");
  expect(screen.queryByRole("button", { name: "查询本次结果" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { goalId, message: "保留原始请求", requestOperationId: operationId, explicitIntent: true },
    { goalId, message: "保留原始请求", requestOperationId: operationId, explicitIntent: true },
  ]);

  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  expect(onRefresh).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
});

it("keeps a known successful reply and offers refresh-only recovery when its workspace refresh fails", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const onRefresh = vi.fn()
    .mockRejectedValueOnce(new Error("private refresh detail"))
    .mockResolvedValueOnce(undefined);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: turnResult }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("本轮回复已经收到，但重新读取目标状态失败");
  expect(screen.getByText(turnResult.message)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "查询本次结果" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  expect(onRefresh).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps a successful turn locked until its deferred workspace refresh completes", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  let finishRefresh: (() => void) | undefined;
  const onRefresh = vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: turnResult }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByText(turnResult.message)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "正在发送…" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  finishRefresh?.();
  expect(await screen.findByRole("button", { name: "发送" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps consecutive known-success refresh failures in refresh-only recovery", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  const onRefresh = vi.fn()
    .mockRejectedValueOnce(new Error("first private refresh failure"))
    .mockRejectedValueOnce(new Error("second private refresh failure"));
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: turnResult }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("本轮回复已经收到，但重新读取目标状态失败");

  await user.click(screen.getByRole("button", { name: "重新读取目标状态" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("本轮回复已经收到，但重新读取目标状态失败");
  expect(screen.queryByRole("button", { name: "查询本次结果" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "发送新一轮" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("admits only the first send when two fresh requests reach the hook in one event", async () => {
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(operationId)
    .mockReturnValueOnce(nextOperationId);
  let finishTurn: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    void input;
    void init;
    return new Promise<Response>(resolve => { finishTurn = resolve; });
  });
  vi.stubGlobal("fetch", fetchMock);

  function DoubleSendHarness() {
    const turn = useAgentTurn(goalId, vi.fn());
    return (
      <button type="button" onClick={() => {
        void turn.send("第一条");
        void turn.send("第二条");
      }}>
        双重发送
      </button>
    );
  }

  const user = userEvent.setup();
  render(<DoubleSendHarness />);
  await user.click(screen.getByRole("button", { name: "双重发送" }));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    message: "第一条",
    requestOperationId: operationId,
  });
  finishTurn?.(Response.json({ ok: true, data: turnResult }));
});

it("replaces the temporary reply with the authoritative conversation without duplicating it", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(operationId);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: turnResult })));
  let finishRefresh: (() => void) | undefined;
  const onRefresh = vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
  const view = render(<AgentChat goalId={goalId} initialMessages={[]} onRefresh={onRefresh} />);

  await user.type(screen.getByLabelText("告诉教练你的目标"), "继续");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText(turnResult.message)).toBeInTheDocument();

  view.rerender(<AgentChat goalId={goalId} initialMessages={[{ id: "server-message", role: "assistant", content: turnResult.message }]} onRefresh={onRefresh} />);
  finishRefresh?.();

  expect(await screen.findAllByText(turnResult.message)).toHaveLength(1);
});
