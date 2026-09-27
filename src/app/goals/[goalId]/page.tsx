import { GoalWorkspace } from "@/components/workspace/goal-workspace";

export default async function GoalPage({ params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = await params;
  return <GoalWorkspace key={goalId} goalId={goalId} />;
}
