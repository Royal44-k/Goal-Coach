"use client";

import type { Goal } from "@/core/domain/contracts";
import type {
  ApprovedPlanResult,
  GoalWorkspace,
  ReplanDraftArtifact,
} from "@/lib/public-api-schemas";
import type { FreshMutationLease } from "@/components/workspace/use-recoverable-workspace-mutation";
import { PlanReviewCard } from "./plan-review-card";

type CurrentPlan = NonNullable<GoalWorkspace["currentPlan"]>;

export function ReplanReview({
  goalId,
  goalStatus,
  goalVersion,
  currentPlan,
  draft,
  disabled,
  onKeepCurrent,
  onRequestRevision,
  onRefresh,
  onApproved,
  tryAcquireFreshMutation,
  releaseFreshMutation,
}: {
  goalId: string;
  goalStatus: Goal["status"];
  goalVersion: number;
  currentPlan: CurrentPlan;
  draft: ReplanDraftArtifact;
  disabled: boolean;
  onKeepCurrent: () => void;
  onRequestRevision: () => void;
  onRefresh: () => Promise<void>;
  onApproved: (result: ApprovedPlanResult) => void | Promise<void>;
  tryAcquireFreshMutation?: (owner: "plan_approval") => FreshMutationLease | null;
  releaseFreshMutation?: (lease: FreshMutationLease) => void;
}) {
  const milestonesChanged = JSON.stringify(currentPlan.milestones) !== JSON.stringify(draft.payload.milestones);
  const revisionAllowed = goalStatus === "active";

  return (
    <section className="replan-review" aria-labelledby="replan-review-title">
      <div className="replan-review__heading">
        <div>
          <p className="section-kicker">调整需要你确认</p>
          <h2 id="replan-review-title">比较两版计划</h2>
        </div>
        <div className="replan-review__versions" aria-label="计划版本状态">
          <p><strong>当前有效</strong> · 计划第 {currentPlan.number} 版</p>
          <p><strong>待批准</strong> · 草案版本 {draft.version}</p>
        </div>
      </div>
      <dl className="replan-review__context">
        <div><dt>来源</dt><dd>{draft.payload.changeSource === "agent" ? "教练建议" : "用户调整"}</dd></div>
        <div><dt>原因</dt><dd>{draft.payload.changeReason ?? "未填写"}</dd></div>
      </dl>
      {milestonesChanged ? (
        <div className="replan-review__milestones">
          <section aria-labelledby="current-milestones-title">
            <h3 id="current-milestones-title">当前有效里程碑</h3>
            <ol aria-label="当前有效里程碑">{currentPlan.milestones.map((milestone, index) => <li key={`${index}-${milestone}`}>{milestone}</li>)}</ol>
          </section>
          <section aria-labelledby="proposed-milestones-title">
            <h3 id="proposed-milestones-title">拟议里程碑</h3>
            <ol aria-label="拟议里程碑">{draft.payload.milestones.map((milestone, index) => <li key={`${index}-${milestone}`}>{milestone}</li>)}</ol>
          </section>
        </div>
      ) : null}
      <div className="replan-review__actions">
        <button type="button" className="button-secondary" disabled={disabled} onClick={onKeepCurrent}>继续使用当前计划（草案 {draft.version} / 目标 {goalVersion}）</button>
        <button type="button" className="button-secondary" disabled={disabled || !revisionAllowed} onClick={onRequestRevision}>要求修改（草案 {draft.version} / 目标 {goalVersion}）</button>
      </div>
      {!revisionAllowed ? <p className="replan-review__notice">恢复目标后才能请教练修改；你仍可保留或批准这份草案。</p> : null}
      <PlanReviewCard
        goalId={goalId}
        draft={draft}
        onRefresh={onRefresh}
        onApproved={onApproved}
        freshMutationBlocked={disabled}
        tryAcquireFreshMutation={tryAcquireFreshMutation}
        releaseFreshMutation={releaseFreshMutation}
        approvalLabel="批准新计划"
      />
    </section>
  );
}
