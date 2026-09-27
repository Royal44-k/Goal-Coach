"use client";

import { useCallback, useRef, useState } from "react";
import type { ZodType } from "zod";
import { apiClient, isReceivedApiError, isUnknownApiOutcomeError } from "@/lib/api-client";
import type { GoalWorkspace as GoalWorkspaceData } from "@/lib/public-api-schemas";
import type { AppErrorCode } from "@/core/errors/app-error";

export type WorkspaceIdentity = { goalId: string; generation: number };
export type FreshMutationOwner = "execution" | "manual_plan" | "plan_approval" | "blocker" | "agent" | "replan_rejection" | "goal_completion" | "goal_delete";
export type FreshMutationLease = Readonly<{
  owner: FreshMutationOwner;
  identity: WorkspaceIdentity;
  token: symbol;
}>;
type FrozenRequest = Readonly<{
  label: string;
  path: string;
  init: RequestInit;
  schema: ZodType<unknown>;
  continuationLabel: string | null;
  onConfirmed: ((lease: FreshMutationLease, workspace: GoalWorkspaceData) => boolean) | null;
  readAuthoritativeState: ((lease: FreshMutationLease) => Promise<AuthoritativeState>) | null;
}>;
type AuthoritativeState =
  | { kind: "workspace"; workspace: GoalWorkspaceData }
  | { kind: "goal_absent"; goalId: string; publish: () => void };
type RecoverableMutationState = {
  phase: "idle" | "running" | "unknown" | "refresh_failed" | "success_refresh_failed" | "received_reconciled" | "confirmed_needs_continuation";
  request: FrozenRequest | null;
  lease: FreshMutationLease | null;
  confirmedWorkspace: GoalWorkspaceData | null;
  receivedErrorCode?: AppErrorCode;
};

const idleState: RecoverableMutationState = { phase: "idle", request: null, lease: null, confirmedWorkspace: null };

export function useRecoverableWorkspaceMutation({
  goalId,
  currentIdentity,
  isCurrent,
  refreshWorkspace,
}: {
  goalId: string;
  currentIdentity: () => WorkspaceIdentity;
  isCurrent: (identity: WorkspaceIdentity) => boolean;
  refreshWorkspace: (identity: WorkspaceIdentity) => Promise<GoalWorkspaceData>;
}) {
  const leaseRef = useRef<FreshMutationLease | null>(null);
  const activityRef = useRef<{ lease: FreshMutationLease; token: symbol } | null>(null);
  const confirmedAuthorityRef = useRef<{
    request: FrozenRequest;
    lease: FreshMutationLease;
    workspace: GoalWorkspaceData;
  } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [state, setState] = useState<RecoverableMutationState>(idleState);

  const isFreshMutationLeaseCurrent = useCallback((lease: FreshMutationLease) => (
    leaseRef.current === lease && isCurrent(lease.identity)
  ), [isCurrent]);

  const tryAcquireFreshMutation = useCallback((owner: FreshMutationOwner): FreshMutationLease | null => {
    if (leaseRef.current) return null;
    const identity = currentIdentity();
    if (identity.goalId !== goalId || !isCurrent(identity)) return null;
    const lease: FreshMutationLease = { owner, identity, token: Symbol(owner) };
    leaseRef.current = lease;
    setBlocked(true);
    return lease;
  }, [currentIdentity, goalId, isCurrent]);

  const releaseFreshMutation = useCallback((lease: FreshMutationLease): boolean => {
    if (!isFreshMutationLeaseCurrent(lease)) return false;
    leaseRef.current = null;
    setBlocked(false);
    return true;
  }, [isFreshMutationLeaseCurrent]);

  const beginActivity = useCallback((lease: FreshMutationLease) => {
    if (activityRef.current || !isFreshMutationLeaseCurrent(lease)) return null;
    const activity = { lease, token: Symbol("workspace-mutation-activity") };
    activityRef.current = activity;
    return activity;
  }, [isFreshMutationLeaseCurrent]);

  const endActivity = useCallback((activity: { lease: FreshMutationLease; token: symbol }) => {
    if (activityRef.current === activity) activityRef.current = null;
  }, []);

  const readState = useCallback(async (request: FrozenRequest, lease: FreshMutationLease): Promise<AuthoritativeState> => {
    if (request.readAuthoritativeState) return request.readAuthoritativeState(lease);
    return { kind: "workspace", workspace: await refreshWorkspace(lease.identity) };
  }, [refreshWorkspace]);

  const commitTerminal = useCallback((
    active: { lease: FreshMutationLease; token: symbol },
    request: FrozenRequest,
    lease: FreshMutationLease,
    terminal: Extract<AuthoritativeState, { kind: "goal_absent" }>,
  ) => {
    if (
      activityRef.current !== active
      || !isFreshMutationLeaseCurrent(lease)
      || lease.owner !== "goal_delete"
      || lease.identity.goalId !== goalId
      || terminal.goalId !== goalId
      || request.readAuthoritativeState === null
    ) return false;
    confirmedAuthorityRef.current = null;
    setState(idleState);
    if (!releaseFreshMutation(lease)) return false;
    terminal.publish();
    return true;
  }, [goalId, isFreshMutationLeaseCurrent, releaseFreshMutation]);

  const run = useCallback(async (request: FrozenRequest, lease: FreshMutationLease, allowAutomaticContinuation: boolean) => {
    const activity = beginActivity(lease);
    if (!activity) return;
    setState({ phase: "running", request, lease, confirmedWorkspace: null });
    try {
      await apiClient.request(request.path, request.init, request.schema);
      if (!isFreshMutationLeaseCurrent(lease)) return;
      let authoritative: AuthoritativeState;
      try {
        authoritative = await readState(request, lease);
      } catch {
        if (isFreshMutationLeaseCurrent(lease)) setState({ phase: "success_refresh_failed", request, lease, confirmedWorkspace: null });
        return;
      }
      if (!isFreshMutationLeaseCurrent(lease)) return;
      if (authoritative.kind === "goal_absent") {
        if (!commitTerminal(activity, request, lease, authoritative)) setState({ phase: "success_refresh_failed", request, lease, confirmedWorkspace: null });
        return;
      }
      if (lease.owner === "goal_delete") {
        setState({ phase: "success_refresh_failed", request, lease, confirmedWorkspace: authoritative.workspace });
        return;
      }
      const refreshed = authoritative.workspace;
      if (request.onConfirmed) {
        let transferred = false;
        if (allowAutomaticContinuation) {
          try {
            transferred = request.onConfirmed(lease, refreshed);
          } catch {
            transferred = false;
          }
        }
        if (transferred) {
          confirmedAuthorityRef.current = null;
          setState(idleState);
        } else {
          confirmedAuthorityRef.current = { request, lease, workspace: refreshed };
          setState({ phase: "confirmed_needs_continuation", request, lease, confirmedWorkspace: refreshed });
        }
      } else {
        confirmedAuthorityRef.current = null;
        releaseFreshMutation(lease);
        setState(idleState);
      }
    } catch (error) {
      if (!isFreshMutationLeaseCurrent(lease)) return;
      if (isUnknownApiOutcomeError(error) || !isReceivedApiError(error)) {
        setState({ phase: "unknown", request, lease, confirmedWorkspace: null });
        return;
      }
      try {
        const authoritative = await readState(request, lease);
        if (!isFreshMutationLeaseCurrent(lease)) return;
        if (authoritative.kind === "goal_absent") {
          if (commitTerminal(activity, request, lease, authoritative)) return;
          throw new Error("Invalid terminal authoritative state");
        }
        releaseFreshMutation(lease);
        setState({ phase: "received_reconciled", request: null, lease: null, confirmedWorkspace: null, receivedErrorCode: error.code });
      } catch {
        if (isFreshMutationLeaseCurrent(lease)) setState({ phase: "refresh_failed", request, lease, confirmedWorkspace: null, receivedErrorCode: error.code });
      }
    } finally {
      endActivity(activity);
    }
  }, [beginActivity, commitTerminal, endActivity, isFreshMutationLeaseCurrent, readState, releaseFreshMutation]);

  const startFreshMutation = useCallback((
    owner: Exclude<FreshMutationOwner, "plan_approval">,
    createRequest: () => {
      label: string;
      path: string;
      method: "POST" | "PATCH" | "DELETE";
      body: unknown;
      schema: ZodType<unknown>;
      continuationLabel?: string;
      onConfirmed?: (lease: FreshMutationLease, workspace: GoalWorkspaceData) => boolean;
      readAuthoritativeState?: (lease: FreshMutationLease) => Promise<AuthoritativeState>;
    },
  ): boolean => {
    const lease = tryAcquireFreshMutation(owner);
    if (!lease) return false;
    let request: FrozenRequest;
    try {
      const created = createRequest();
      request = Object.freeze({
        label: created.label,
        path: created.path,
        init: Object.freeze({
          method: created.method,
          headers: Object.freeze({ "Content-Type": "application/json" }),
          body: JSON.stringify(created.body),
        }),
        schema: created.schema,
        continuationLabel: created.continuationLabel ?? null,
        onConfirmed: created.onConfirmed ?? null,
        readAuthoritativeState: created.readAuthoritativeState ?? null,
      });
    } catch (error) {
      releaseFreshMutation(lease);
      throw error;
    }
    void run(request, lease, true);
    return true;
  }, [releaseFreshMutation, run, tryAcquireFreshMutation]);

  const replayExactMutation = useCallback(() => {
    if (state.phase !== "unknown" || !state.request || !state.lease || !isFreshMutationLeaseCurrent(state.lease)) return;
    void run(state.request, state.lease, false);
  }, [isFreshMutationLeaseCurrent, run, state]);

  const reconcileMutation = useCallback(async () => {
    if ((state.phase !== "refresh_failed" && state.phase !== "success_refresh_failed") || !state.lease || !isFreshMutationLeaseCurrent(state.lease)) return;
    const activity = beginActivity(state.lease);
    if (!activity) return;
    const previous = state;
    setState({ ...state, phase: "running" });
    try {
      if (!state.request) return;
      const authoritative = await readState(state.request, state.lease);
      if (!isFreshMutationLeaseCurrent(state.lease)) return;
      if (authoritative.kind === "goal_absent") {
        if (commitTerminal(activity, state.request, state.lease, authoritative)) return;
        setState(previous);
        return;
      }
      if (state.lease.owner === "goal_delete" && previous.phase === "success_refresh_failed") {
        setState(previous);
        return;
      }
      const refreshed = authoritative.workspace;
      if (previous.phase === "success_refresh_failed" && previous.request?.onConfirmed) {
        confirmedAuthorityRef.current = { request: previous.request, lease: state.lease, workspace: refreshed };
        setState({ phase: "confirmed_needs_continuation", request: previous.request, lease: state.lease, confirmedWorkspace: refreshed });
      } else {
        releaseFreshMutation(state.lease);
        setState(previous.phase === "refresh_failed"
          ? {
              phase: "received_reconciled",
              request: null,
              lease: null,
              confirmedWorkspace: null,
              receivedErrorCode: previous.receivedErrorCode,
            }
          : idleState);
      }
    } catch {
      if (isFreshMutationLeaseCurrent(state.lease)) setState(previous);
    } finally {
      endActivity(activity);
    }
  }, [beginActivity, commitTerminal, endActivity, isFreshMutationLeaseCurrent, readState, releaseFreshMutation, state]);

  const refreshUnknownMutation = useCallback(async () => {
    if (state.phase !== "unknown" || !state.request || !state.lease || !isFreshMutationLeaseCurrent(state.lease)) return;
    const activity = beginActivity(state.lease);
    if (!activity) return;
    const previous = state;
    setState({ ...state, phase: "running" });
    let terminal = false;
    try {
      const authoritative = await readState(state.request, state.lease);
      if (authoritative.kind === "goal_absent") terminal = commitTerminal(activity, state.request, state.lease, authoritative);
    } catch {
      // Reading formal state is safe to repeat; retain the unresolved exact request.
    } finally {
      if (!terminal && isFreshMutationLeaseCurrent(state.lease)) setState(previous);
      endActivity(activity);
    }
  }, [beginActivity, commitTerminal, endActivity, isFreshMutationLeaseCurrent, readState, state]);

  const continueConfirmedMutation = useCallback(() => {
    const authority = confirmedAuthorityRef.current;
    if (!authority?.request.onConfirmed || !isFreshMutationLeaseCurrent(authority.lease)) return false;
    confirmedAuthorityRef.current = null;
    let transferred = false;
    try {
      transferred = authority.request.onConfirmed(authority.lease, authority.workspace);
    } catch {
      transferred = false;
    }
    if (transferred) {
      setState(idleState);
    } else if (isFreshMutationLeaseCurrent(authority.lease)) {
      confirmedAuthorityRef.current = authority;
    }
    return transferred;
  }, [isFreshMutationLeaseCurrent]);

  const cancelConfirmedContinuation = useCallback(() => {
    const authority = confirmedAuthorityRef.current;
    if (!authority || !isFreshMutationLeaseCurrent(authority.lease)) return false;
    confirmedAuthorityRef.current = null;
    releaseFreshMutation(authority.lease);
    setState(idleState);
    return true;
  }, [isFreshMutationLeaseCurrent, releaseFreshMutation]);

  return {
    blocked,
    state,
    isFreshMutationLeaseCurrent,
    tryAcquireFreshMutation,
    releaseFreshMutation,
    startFreshMutation,
    replayExactMutation,
    reconcileMutation,
    refreshUnknownMutation,
    continueConfirmedMutation,
    cancelConfirmedContinuation,
  } as const;
}
