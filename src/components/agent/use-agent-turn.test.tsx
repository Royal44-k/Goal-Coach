// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { FreshMutationLease } from "@/components/workspace/use-recoverable-workspace-mutation";
import { useAgentTurn } from "./use-agent-turn";

const goalId = "57000000-0000-4000-8000-000000000001";
const firstOperationId = "57000000-0000-4000-8000-000000000002";
const secondOperationId = "57000000-0000-4000-8000-000000000003";
const firstLease: FreshMutationLease = {
  owner: "agent",
  identity: { goalId, generation: 1 },
  token: Symbol("first"),
};
const handedLease: FreshMutationLease = {
  owner: "blocker",
  identity: { goalId, generation: 1 },
  token: Symbol("handed"),
};
const success = {
  message: "先完成最小步骤",
  state: "active",
  advice: {
    minimumNextStep: "先列出一个最小步骤",
    explanation: "任务偏大，先缩小起点。",
    taskId: null,
    blockerCategory: "task_too_large",
  },
  persistedChange: false,
  usage: { inputTokens: 10, outputTokens: 8, modelCalls: 1, toolCalls: 1 },
};

function Harness({
  acquire,
  release,
  isCurrent,
  onRefresh = vi.fn().mockResolvedValue(undefined),
}: {
  acquire: () => FreshMutationLease | null;
  release: (lease: FreshMutationLease) => void;
  isCurrent: (lease: FreshMutationLease) => boolean;
  onRefresh?: () => Promise<void>;
}) {
  const turn = useAgentTurn(goalId, onRefresh, undefined, {
    tryAcquireFreshMutation: acquire,
    releaseFreshMutation: release,
    isFreshMutationLeaseCurrent: isCurrent,
  });
  return <>
    <p aria-label="turn-phase">{turn.phase}</p>
    <p aria-label="turn-error-code">{turn.receivedErrorCode ?? "none"}</p>
    <button type="button" onClick={() => void turn.send("第一轮")}>发送第一轮</button>
    <button type="button" onClick={() => turn.sendWithLease("接续分析", handedLease)}>接续已有租约</button>
    <button type="button" onClick={() => void turn.sendNew("显式新一轮")}>发送显式新一轮</button>
  </>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("acquires the shared lease before allocating an id and releases it after known success", async () => {
  const user = userEvent.setup();
  const order: string[] = [];
  const acquire = vi.fn(() => { order.push("acquire"); return firstLease; });
  const release = vi.fn();
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => { order.push("uuid"); return firstOperationId; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: success })));
  render(<Harness acquire={acquire} release={release} isCurrent={lease => lease === firstLease} />);

  await user.click(screen.getByRole("button", { name: "发送第一轮" }));

  await waitFor(() => expect(screen.getByLabelText("turn-phase")).toHaveTextContent("idle"));
  expect(order).toEqual(["acquire", "uuid"]);
  expect(release).toHaveBeenCalledWith(firstLease);
});

it("accepts a current handed lease from received_reconciled without reacquiring", async () => {
  const user = userEvent.setup();
  const acquire = vi.fn().mockReturnValue(firstLease);
  const release = vi.fn();
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(firstOperationId)
    .mockReturnValueOnce(secondOperationId);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: false, error: { code: "INVALID_TRANSITION", message: "暂时不可用" } }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: success }));
  vi.stubGlobal("fetch", fetchMock);
  render(<Harness
    acquire={acquire}
    release={release}
    isCurrent={lease => lease === firstLease || lease === handedLease}
  />);

  await user.click(screen.getByRole("button", { name: "发送第一轮" }));
  await screen.findByText("received_reconciled");
  expect(screen.getByLabelText("turn-error-code")).toHaveTextContent("INVALID_TRANSITION");
  expect(release).toHaveBeenCalledWith(firstLease);

  await user.click(screen.getByRole("button", { name: "接续已有租约" }));
  await waitFor(() => expect(screen.getByLabelText("turn-phase")).toHaveTextContent("idle"));
  expect(screen.getByLabelText("turn-error-code")).toHaveTextContent("none");
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenLastCalledWith(handedLease);
  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  expect(bodies).toEqual([
    { goalId, message: "第一轮", requestOperationId: firstOperationId, explicitIntent: true },
    { goalId, message: "接续分析", requestOperationId: secondOperationId, explicitIntent: true },
  ]);
});

it("retains a received timeout code when authoritative refresh fails", async () => {
  const user = userEvent.setup();
  const acquire = vi.fn().mockReturnValue(firstLease);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(firstOperationId);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    ok: false,
    error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" },
  }, { status: 504 })));
  render(<Harness
    acquire={acquire}
    release={vi.fn()}
    isCurrent={lease => lease === firstLease}
    onRefresh={vi.fn().mockRejectedValue(new Error("refresh unavailable"))}
  />);

  await user.click(screen.getByRole("button", { name: "发送第一轮" }));

  await waitFor(() => expect(screen.getByLabelText("turn-phase")).toHaveTextContent("refresh_failed"));
  expect(screen.getByLabelText("turn-error-code")).toHaveTextContent("MODEL_TIMEOUT");
});

it("clears a received error code before a fresh turn becomes unknown", async () => {
  const user = userEvent.setup();
  const acquire = vi.fn().mockReturnValue(firstLease);
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(firstOperationId)
    .mockReturnValueOnce(secondOperationId);
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({
      ok: false,
      error: { code: "MODEL_TIMEOUT", message: "模型响应超时，请重试。" },
    }, { status: 504 }))
    .mockRejectedValueOnce(new TypeError("response unavailable")));
  render(<Harness
    acquire={acquire}
    release={vi.fn()}
    isCurrent={lease => lease === firstLease}
  />);

  await user.click(screen.getByRole("button", { name: "发送第一轮" }));
  await screen.findByText("received_reconciled");
  expect(screen.getByLabelText("turn-error-code")).toHaveTextContent("MODEL_TIMEOUT");

  await user.click(screen.getByRole("button", { name: "发送显式新一轮" }));

  await waitFor(() => expect(screen.getByLabelText("turn-phase")).toHaveTextContent("unknown_outcome"));
  expect(screen.getByLabelText("turn-error-code")).toHaveTextContent("none");
});

it("does not allocate an id or send when a fresh or handed lease is unavailable", async () => {
  const user = userEvent.setup();
  const acquire = vi.fn().mockReturnValue(null);
  const release = vi.fn();
  const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<Harness acquire={acquire} release={release} isCurrent={() => false} />);

  await user.click(screen.getByRole("button", { name: "发送第一轮" }));
  await user.click(screen.getByRole("button", { name: "接续已有租约" }));

  expect(uuid).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});
