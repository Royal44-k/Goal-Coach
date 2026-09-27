import { expect, it } from "vitest";
import { isReviewEligible } from "./review-eligibility";

const goal = { id: "goal", ownerId: "owner", currentPlanVersionId: "plan" };
const plan = { id: "plan", goalId: "goal", ownerId: "owner", status: "approved" as const };
const task = { goalId: "goal", ownerId: "owner", planVersionId: "plan", status: "done" as const };
it("requires a current approved plan and a nonempty set entirely done with matching ownership and lineage", () => {
  expect(isReviewEligible(goal, plan, [task])).toBe(true);
  expect(isReviewEligible(goal, null, [task])).toBe(false);
  expect(isReviewEligible(goal, plan, [])).toBe(false);
  expect(isReviewEligible(goal, plan, [task, { ...task, status: "skipped" }])).toBe(false);
  expect(isReviewEligible(goal, plan, [{ ...task, status: "todo" }])).toBe(false);
  expect(isReviewEligible(goal, { ...plan, status: "draft" }, [task])).toBe(false);
  expect(isReviewEligible({ ...goal, currentPlanVersionId: null }, plan, [task])).toBe(false);
  expect(isReviewEligible(goal, { ...plan, id: "old" }, [task])).toBe(false);
  expect(isReviewEligible(goal, { ...plan, goalId: "other" }, [task])).toBe(false);
  expect(isReviewEligible(goal, { ...plan, ownerId: "other" }, [task])).toBe(false);
  for (const patch of [{ goalId: "other" }, { ownerId: "other" }, { planVersionId: "old" }])
    expect(isReviewEligible(goal, plan, [{ ...task, ...patch }])).toBe(false);
});
