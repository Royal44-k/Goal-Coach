import { z } from "zod";
import {
  GoalSchema,
  CheckInSchema,
  PlanVersionSchema,
  TaskSchema,
  UserPreferenceSchema,
  type AgentState,
} from "@/core/domain/contracts";
import { AppError } from "@/core/errors/app-error";
import { calculateProgress } from "@/core/planning/progress";
import type { Repositories, RepositoryUnitOfWork } from "../repositories/repository-types";
import { ModelToolDefinitionSchema } from "./model-contracts";
import { modelToolDefinitions, toolRegistry } from "./tool-registry";
import { PlanMilestonesSchema, PlanRevisionEnvelopeSchema } from "../repositories/revision-contracts";
import { planningFacts, planningProjection, shanghaiInstant } from "../services/workspace-projection";
import { undoCandidate } from "../operations/undo-candidate";

const FeedbackContextSchema = z.object({
  taskId: CheckInSchema.shape.taskId,
  taskTitle: TaskSchema.shape.title.nullable(),
  kind: CheckInSchema.shape.kind,
  blockerCategory: CheckInSchema.shape.blockerCategory,
  note: z.string().refine(value => [...value].length <= 1000).nullable(),
  minutesSpent: CheckInSchema.shape.minutesSpent,
  availableWeeklyMinutes: CheckInSchema.shape.availableWeeklyMinutes,
  createdAt: CheckInSchema.shape.createdAt,
}).strict();
const PlanningFactsSchema = z.object({
  latestAvailableWeeklyMinutes: CheckInSchema.shape.availableWeeklyMinutes,
  estimatedRemainingCapacityMinutes: z.number().int().nonnegative().nullable(),
  replanTriggers: z.array(z.object({
    code: z.enum(["actual_overrun", "repeated_skip", "capacity_overload", "availability_reduced", "unresolved_blocker"]),
    taskId: TaskSchema.shape.id.optional(),
    reason: z.string().min(1),
  }).strict()),
}).strict();

const CurrentPlanContextSchema = PlanVersionSchema.pick({
  id: true,
  version: true,
  number: true,
  status: true,
  changeSource: true,
}).extend({
  changeReason: PlanVersionSchema.shape.changeReason.unwrap().optional(),
  approvedAt: PlanVersionSchema.shape.approvedAt.unwrap().optional(),
  milestones: PlanMilestonesSchema,
}).strict();

const RecentMessageContextSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
}).strict();

const ConversationSummaryContextSchema = z.object({
  content: z.string().trim().min(1),
}).strict();

const UserPreferenceContextSchema = UserPreferenceSchema.pick({
  taskGranularity: true,
  estimateBias: true,
  commonBlockers: true,
  effectiveStrategies: true,
}).extend({
  preferredTimeWindow: UserPreferenceSchema.shape.preferredTimeWindow.unwrap().optional(),
}).strict();

export const AgentContextSchema = z.object({
  currentDate: z.iso.date(),
  timeZone: z.literal("Asia/Shanghai"),
  fenceRevision: z.number().int().nonnegative(),
  undoCandidate: z.object({ id: z.string().uuid(), kind: z.enum(["task_execution", "check_in"]), label: z.string(), expectedGoalVersion: z.number().int().positive() }).strict().nullable(),
  currentGoal: GoalSchema,
  currentPlan: CurrentPlanContextSchema.optional(),
  currentTasks: z.array(TaskSchema),
  currentProgress: toolRegistry.get_progress.resultSchema,
  recentCheckIns: z.array(FeedbackContextSchema).max(10),
  planningFacts: PlanningFactsSchema,
  conversationSummary: ConversationSummaryContextSchema.optional(),
  recentMessages: z.array(RecentMessageContextSchema).max(6),
  userPreference: UserPreferenceContextSchema.optional(),
  tools: z.array(ModelToolDefinitionSchema),
}).strict();
export type AgentContext = z.infer<typeof AgentContextSchema>;

export async function buildAgentContext(input: {
  ownerId: string;
  goalId: string;
  repositories: Repositories & RepositoryUnitOfWork;
  now?: Date;
}): Promise<AgentContext> {
  const now = input.now ?? new Date();
  const context = await input.repositories.withTransaction((repositories) => {
    const goal = repositories.goals.get(input.ownerId, input.goalId);
    if (!goal)
      throw new AppError("NOT_FOUND", 404, "Goal is unavailable for agent context");
    const projection = planningProjection(repositories, input.ownerId, goal.id);
    const { plan, tasks } = projection;
    const taskTitles = new Map(tasks.map(task => [task.id, task.title]));
    const conversation = repositories.conversations.getSnapshot(input.ownerId, goal.id);
    const preference = repositories.support.getPreferencesByOwner(input.ownerId);
    const tools = modelToolDefinitions().filter(tool =>
      toolRegistry[tool.name].permissionClass !== "read"
      && (toolRegistry[tool.name].allowedStates as readonly AgentState[]).includes(goal.agentState));
    const undo = undoCandidate(repositories, input.ownerId, goal.id);
    return {
      currentDate: shanghaiInstant(now).slice(0, 10),
      timeZone: "Asia/Shanghai" as const,
      fenceRevision: conversation.fenceRevision,
      undoCandidate: undo.canUndo && undo.candidate ? { ...undo.candidate, expectedGoalVersion: goal.version } : null,
      currentGoal: goal,
      ...(plan ? { currentPlan: {
        id: plan.id,
        version: plan.version,
        number: plan.number,
        status: plan.status,
        changeSource: plan.changeSource,
        ...(plan.changeReason === null ? {} : { changeReason: plan.changeReason }),
        ...(plan.approvedAt === null ? {} : { approvedAt: plan.approvedAt }),
        milestones: PlanRevisionEnvelopeSchema.parse(plan.diff).revision.payload.milestones,
      } } : {}),
      currentTasks: tasks,
      currentProgress: calculateProgress(tasks),
      // Ten relevant records keep near-term feedback useful; Unicode truncation bounds
      // free text without splitting surrogate pairs or exposing persistence internals.
      recentCheckIns: projection.projectedCheckIns.slice(-10).map(({ taskId, kind, blockerCategory, note, minutesSpent, availableWeeklyMinutes, createdAt }) => ({
        taskId, taskTitle: taskId === null ? null : taskTitles.get(taskId) ?? null,
        kind, blockerCategory, note: note === null ? null : [...note].slice(0, 1000).join(""),
        minutesSpent, availableWeeklyMinutes, createdAt,
      })),
      planningFacts: planningFacts(projection, now),
      ...(conversation.summary ? { conversationSummary: { content: conversation.summary.content } } : {}),
      recentMessages: conversation.unsummarizedMessages.slice(-6).map(({ role, content }) => ({ role, content })),
      ...(preference ? { userPreference: {
        taskGranularity: preference.taskGranularity,
        ...(preference.preferredTimeWindow === null ? {} : { preferredTimeWindow: preference.preferredTimeWindow }),
        estimateBias: preference.estimateBias,
        commonBlockers: preference.commonBlockers,
        effectiveStrategies: preference.effectiveStrategies,
      } } : {}),
      tools,
    };
  });
  return AgentContextSchema.parse(context);
}
