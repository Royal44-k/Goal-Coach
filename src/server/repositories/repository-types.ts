import type * as d from "@/core/domain/contracts";
import type * as i from "./repository-inputs";
import type { TaskCreateInput, PlanVersionCreateInput } from "./revision-contracts";
import type { ModelUsageReceipt } from "./model-usage-receipt";
export * from "./repository-inputs";
export * from "./revision-contracts";
export interface GoalRepository {
  create(ownerId: string, input: i.GoalCreateInput): Promise<d.Goal>;
  get(ownerId: string, goalId: string): Promise<d.Goal | null>;
  list(ownerId: string): Promise<d.Goal[]>;
  update(ownerId: string, goalId: string, expectedVersion: number, patch: i.GoalPatch): Promise<d.Goal>;
  delete(ownerId: string, goalId: string): Promise<void>;
}
export interface TaskRepository {
  createMany(ownerId: string, goalId: string, planVersionId: string, inputs: TaskCreateInput[]): Promise<d.Task[]>;
  get(ownerId: string, taskId: string): Promise<d.Task | null>;
  listByGoal(ownerId: string, goalId: string, planVersionId: string): Promise<d.Task[]>;
  update(ownerId: string, taskId: string, expectedVersion: number, patch: i.TaskPatch): Promise<d.Task>;
  delete(ownerId: string, taskId: string): Promise<void>;
}
export interface PlanRepository {
  createDraft(ownerId: string, goalId: string, input: PlanVersionCreateInput): Promise<d.PlanVersion>;
  getDraftArtifact(ownerId: string, draftId: string): Promise<d.DraftArtifact | null>;
  saveDraftArtifact(ownerId: string, input: i.DraftArtifactCreateInput): Promise<d.DraftArtifact>;
  updateDraftArtifact(ownerId: string, draftId: string, expectedVersion: number, patch: {
    status: d.DraftArtifact["status"];
  }): Promise<d.DraftArtifact>;
  approve(ownerId: string, planVersionId: string, expectedVersion: number): Promise<d.PlanVersion>;
  getCurrent(ownerId: string, goalId: string): Promise<d.PlanVersion | null>;
  listVersions(ownerId: string, goalId: string): Promise<d.PlanVersion[]>;
}
export interface ConversationRepository {
  append(ownerId: string, goalId: string, message: i.ConversationMessageCreateInput): Promise<d.ConversationMessage>;
  last(ownerId: string, goalId: string, limit: number): Promise<d.ConversationMessage[]>;
  getSummary(ownerId: string, goalId: string): Promise<d.ConversationSummary | null>;
  getSnapshot(ownerId: string, goalId: string): Promise<ConversationSnapshot>;
  replaceSummary(ownerId: string, goalId: string, summary: i.ConversationSummaryInput): Promise<d.ConversationSummary>;
  replaceSummaryIfSnapshotMatches(
    ownerId: string,
    goalId: string,
    input: CompareAndReplaceConversationSummaryInput,
  ): Promise<d.ConversationSummary | null>;
}
export type ConversationSummarySnapshot = Pick<d.ConversationSummary, "id" | "version" | "throughMessageId">;
export type ConversationSnapshot = {
  fenceRevision: number;
  summary: d.ConversationSummary | null;
  unsummarizedMessages: d.ConversationMessage[];
};
export type CompareAndReplaceConversationSummaryInput = {
  expectedFenceRevision: number;
  expectedSummary: ConversationSummarySnapshot | null;
  throughMessageId: string;
  content: string;
};
export type OwnerExportData = {
  goals: d.Goal[];
  tasks: d.Task[];
  planVersions: d.PlanVersion[];
  checkIns: d.CheckIn[];
  evidence: d.TaskEvidence[];
  preferences: d.UserPreference[];
  conversationSummaries: d.ConversationSummary[];
  conversationMessages: d.ConversationMessage[];
};
export interface SupportRepository {
  consumeDailyAgentAdmission(ownerId: string, day: string, limit: number): Promise<void>;
  retainAccountModelUsage(ownerId: string, receipt: ModelUsageReceipt): Promise<void>;
  listAccountModelUsage(ownerId: string, day: string): Promise<ModelUsageReceipt[]>;
  listPendingDraftArtifacts(ownerId: string, goalId: string): Promise<d.DraftArtifact[]>;
  createCheckIn(ownerId: string, input: i.CheckInCreateInput): Promise<d.CheckIn>;
  getCheckIn(ownerId: string, id: string): Promise<d.CheckIn | null>;
  withdrawCheckIn(ownerId: string, id: string, expectedVersion: number, withdrawnAt: string): Promise<d.CheckIn>;
  listCheckInsByGoal(ownerId: string, goalId: string): Promise<d.CheckIn[]>;
  createTaskEvidence(ownerId: string, input: i.TaskEvidenceCreateInput): Promise<d.TaskEvidence>;
  getTaskEvidence(ownerId: string, id: string): Promise<d.TaskEvidence | null>;
  listEvidenceByTask(ownerId: string, taskId: string): Promise<d.TaskEvidence[]>;
  createAgentRun(ownerId: string, input: i.AgentRunCreateInput): Promise<d.AgentRun>;
  getAgentRun(ownerId: string, id: string): Promise<d.AgentRun | null>;
  updateAgentRun(ownerId: string, id: string, expectedVersion: number, patch: i.AgentRunPatch): Promise<d.AgentRun>;
  createApprovalGrant(ownerId: string, input: i.ApprovalGrantCreateInput): Promise<d.ApprovalGrant>;
  getApprovalGrant(ownerId: string, id: string): Promise<d.ApprovalGrant | null>;
  consumeApprovalGrant(ownerId: string, input: i.ConsumeApprovalGrantInput): Promise<d.ApprovalGrant | null>;
  createOperation(ownerId: string, input: i.OperationCreateInput): Promise<d.Operation>;
  getOperation(ownerId: string, id: string): Promise<d.Operation | null>;
  getOperationByOperationId(ownerId: string, operationId: string): Promise<d.Operation | null>;
  listSucceededAgentTurnOperations(ownerId: string, goalId: string): Promise<d.Operation[]>;
  listModelUsageReceipts(ownerId: string, day: string): Promise<ModelUsageReceipt[]>;
  updateOperation(ownerId: string, id: string, expectedVersion: number, patch: i.OperationPatch): Promise<d.Operation>;
  createUndoRecord(ownerId: string, input: i.UndoRecordCreateInput): Promise<d.UndoRecord>;
  getUndoRecord(ownerId: string, id: string): Promise<d.UndoRecord | null>;
  listUndoRecordsByGoal(ownerId: string, goalId: string): Promise<d.UndoRecord[]>;
  getLatestPendingUndo(ownerId: string, goalId: string): Promise<d.UndoRecord | null>;
  updateUndoRecord(ownerId: string, id: string, expectedVersion: number, patch: i.UndoRecordPatch): Promise<d.UndoRecord>;
  createUserPreference(ownerId: string, input: i.UserPreferenceCreateInput): Promise<d.UserPreference>;
  getUserPreference(ownerId: string, id: string): Promise<d.UserPreference | null>;
  getPreferencesByOwner(ownerId: string): Promise<d.UserPreference | null>;
  updateUserPreference(ownerId: string, id: string, expectedVersion: number, patch: i.UserPreferencePatch): Promise<d.UserPreference>;
  createAuditEvent(ownerId: string, input: i.AuditEventCreateInput): Promise<d.AuditEvent>;
  getAuditEvent(ownerId: string, id: string): Promise<d.AuditEvent | null>;
  listAuditEventsByGoal(ownerId: string, goalId: string): Promise<d.AuditEvent[]>;
  createAppSetting(ownerId: string, input: i.AppSettingCreateInput): Promise<d.AppSetting>;
  getAppSetting(ownerId: string, id: string): Promise<d.AppSetting | null>;
  getSettingsByOwner(ownerId: string): Promise<d.AppSetting | null>;
  updateAppSetting(ownerId: string, id: string, expectedVersion: number, patch: i.AppSettingPatch): Promise<d.AppSetting>;
  exportOwnerData(ownerId: string): Promise<OwnerExportData>;
  clearOwnerData(ownerId: string, retainedOperationId: string): Promise<Record<string, number>>;
}
export type SyncRepository<R> = {
  [K in keyof R]: R[K] extends (...args: infer A) => Promise<infer V> ? (...args: A) => V : never;
};
export type Repositories = {
  goals: GoalRepository;
  tasks: TaskRepository;
  plans: PlanRepository;
  conversations: ConversationRepository;
  support: SupportRepository;
};
export type TransactionRepositories = {
  [K in keyof Repositories]: SyncRepository<Repositories[K]>;
};
export type NonThenable<T> = T extends PromiseLike<unknown> ? never : T;
export interface RepositoryUnitOfWork {
  withTransaction<T>(callback: (repositories: TransactionRepositories) => T & NonThenable<T>): Promise<T>;
}
