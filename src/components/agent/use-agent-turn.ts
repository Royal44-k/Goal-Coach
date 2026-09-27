"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiClient,
  isReceivedApiError,
  isUnknownApiOutcomeError,
} from "@/lib/api-client";
import { AgentTurnResultSchema, type AgentTurnResult } from "@/lib/public-api-schemas";
import type { FreshMutationLease } from "@/components/workspace/use-recoverable-workspace-mutation";
import type { AppErrorCode } from "@/core/errors/app-error";

export type AgentTurnPhase =
  | "idle"
  | "running"
  | "unknown_outcome"
  | "received_needs_refresh"
  | "received_reconciled"
  | "refresh_failed"
  | "success_refresh_failed";

export type AgentTurnRequest = {
  goalId: string;
  message: string;
  requestOperationId: string;
  explicitIntent: boolean;
};

type SharedLeaseOptions = {
  tryAcquireFreshMutation: (owner: "agent") => FreshMutationLease | null;
  releaseFreshMutation: (lease: FreshMutationLease) => void;
  isFreshMutationLeaseCurrent: (lease: FreshMutationLease) => boolean;
};

export function useAgentTurn(
  goalId: string,
  onRefresh: () => Promise<void>,
  onResult?: (result: AgentTurnResult) => void | Promise<void>,
  leaseOptions?: SharedLeaseOptions,
) {
  const [phase, setPhase] = useState<AgentTurnPhase>("idle");
  const [result, setResult] = useState<AgentTurnResult | null>(null);
  const [request, setRequest] = useState<AgentTurnRequest | null>(null);
  const [receivedErrorCode, setReceivedErrorCode] = useState<AppErrorCode | null>(null);
  const goalGeneration = useRef(0);
  const executionGeneration = useRef(0);
  const phaseRef = useRef<AgentTurnPhase>("idle");
  const refreshInFlight = useRef(false);
  const reconciliationKind = useRef<"unknown" | "received" | "success">("received");
  const refreshRef = useRef(onRefresh);
  const resultRef = useRef(onResult);
  const leaseOptionsRef = useRef(leaseOptions);
  const activeLeaseRef = useRef<FreshMutationLease | null>(null);

  useEffect(() => { refreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => { resultRef.current = onResult; }, [onResult]);
  useEffect(() => { leaseOptionsRef.current = leaseOptions; }, [leaseOptions]);
  useEffect(() => {
    return () => {
      goalGeneration.current += 1;
      executionGeneration.current += 1;
      refreshInFlight.current = false;
    };
  }, [goalId]);

  const transition = useCallback((next: AgentTurnPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const releaseLease = useCallback((lease: FreshMutationLease | null) => {
    const options = leaseOptionsRef.current;
    if (!lease || activeLeaseRef.current !== lease || !options?.isFreshMutationLeaseCurrent(lease)) return;
    activeLeaseRef.current = null;
    options.releaseFreshMutation(lease);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current || ![
      "unknown_outcome",
      "refresh_failed",
      "success_refresh_failed",
    ].includes(phaseRef.current)) return false;
    refreshInFlight.current = true;
    const generation = goalGeneration.current;
    const execution = ++executionGeneration.current;
    try {
      await refreshRef.current();
      if (goalGeneration.current === generation && executionGeneration.current === execution) {
        if (reconciliationKind.current === "unknown") {
          transition("unknown_outcome");
        } else if (reconciliationKind.current === "received") {
          releaseLease(activeLeaseRef.current);
          transition("received_reconciled");
        } else {
          releaseLease(activeLeaseRef.current);
          transition("idle");
        }
      }
      return true;
    } catch {
      if (goalGeneration.current === generation && executionGeneration.current === execution) {
        transition(reconciliationKind.current === "success" ? "success_refresh_failed" : "refresh_failed");
      }
      return false;
    } finally {
      if (executionGeneration.current === execution) refreshInFlight.current = false;
    }
  }, [releaseLease, transition]);

  const execute = useCallback(async (nextRequest: AgentTurnRequest, requestLease: FreshMutationLease | null) => {
    const generation = goalGeneration.current;
    const execution = ++executionGeneration.current;
    setRequest(nextRequest);
    setReceivedErrorCode(null);
    transition("running");
    try {
      const nextResult = await apiClient.request("/api/agent/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextRequest),
      }, AgentTurnResultSchema);
      if (goalGeneration.current !== generation || executionGeneration.current !== execution || nextRequest.goalId !== goalId) return null;
      reconciliationKind.current = "success";
      setReceivedErrorCode(null);
      setResult(nextResult);
      try {
        await resultRef.current?.(nextResult);
        if (goalGeneration.current !== generation || executionGeneration.current !== execution) return null;
        releaseLease(requestLease);
        transition("idle");
      } catch {
        if (goalGeneration.current !== generation || executionGeneration.current !== execution) return null;
        transition("success_refresh_failed");
      }
      return nextResult;
    } catch (error) {
      if (goalGeneration.current !== generation || executionGeneration.current !== execution || nextRequest.goalId !== goalId) return null;
      if (isUnknownApiOutcomeError(error)) {
        reconciliationKind.current = "unknown";
        setReceivedErrorCode(null);
        transition("unknown_outcome");
      } else if (isReceivedApiError(error)) {
        reconciliationKind.current = "received";
        setReceivedErrorCode(error.code);
        transition("received_needs_refresh");
        try {
          await refreshRef.current();
          if (goalGeneration.current === generation && executionGeneration.current === execution) {
            releaseLease(requestLease);
            transition("received_reconciled");
          }
        } catch {
          if (goalGeneration.current === generation && executionGeneration.current === execution) transition("refresh_failed");
        }
      } else {
        reconciliationKind.current = "unknown";
        setReceivedErrorCode(null);
        transition("unknown_outcome");
      }
      return null;
    }
  }, [goalId, releaseLease, transition]);

  const beginFreshRequest = useCallback((message: string, explicitIntent: boolean, allowedPhases: AgentTurnPhase[]) => {
    const normalized = message.trim();
    if (!normalized || !allowedPhases.includes(phaseRef.current)) return null;
    const options = leaseOptionsRef.current;
    const lease = options?.tryAcquireFreshMutation("agent") ?? null;
    if (options && !lease) return null;
    activeLeaseRef.current = lease;
    return {
      request: { goalId, message: normalized, requestOperationId: crypto.randomUUID(), explicitIntent },
      lease,
    };
  }, [goalId]);

  const send = useCallback((message: string, explicitIntent = true) => {
    const started = beginFreshRequest(message, explicitIntent, ["idle"]);
    if (!started) return Promise.resolve(null);
    return execute(started.request, started.lease);
  }, [beginFreshRequest, execute]);

  const sendWithLease = useCallback((message: string, lease: FreshMutationLease) => {
    const normalized = message.trim();
    const options = leaseOptionsRef.current;
    if (
      !normalized
      || (phaseRef.current !== "idle" && phaseRef.current !== "received_reconciled")
      || !options?.isFreshMutationLeaseCurrent(lease)
    ) return false;
    activeLeaseRef.current = lease;
    const nextRequest = { goalId, message: normalized, requestOperationId: crypto.randomUUID(), explicitIntent: true };
    void execute(nextRequest, lease);
    return true;
  }, [execute, goalId]);

  const lookup = useCallback(() => {
    if (refreshInFlight.current || !request || (phaseRef.current !== "unknown_outcome" && phaseRef.current !== "refresh_failed")) {
      return Promise.resolve(null);
    }
    return execute(request, activeLeaseRef.current);
  }, [execute, request]);

  const sendNew = useCallback((message: string) => {
    const started = beginFreshRequest(message, true, ["received_reconciled"]);
    if (!started) return Promise.resolve(null);
    return execute(started.request, started.lease);
  }, [beginFreshRequest, execute]);

  return { phase, result, request, receivedErrorCode, send, sendWithLease, lookup, sendNew, refresh } as const;
}
