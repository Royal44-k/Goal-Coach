> 历史设计/执行记录，保留当时决策；路径已匿名化。当前行为、默认值和发布权限以仓库当前规格及本次发布说明为准。

# Unified Undo and Local Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the existing reversible-feedback gap and deliver a verified Windows-local application with model configuration retained but inactive.

**Architecture:** Extend the existing undo ledger and transactional services rather than adding a second withdrawal workflow. Feed all current analysis from active feedback while preserving history and fencing stale conversational context. Deliver safe local launch and source-packaging tools without changing deployment/security boundaries.

**Tech Stack:** Existing Next 16.3.4, React 19.2.8, Zod, Drizzle/SQLite, Vitest 5, Playwright Edge; Node 24.20.0 and pnpm 11.19.0.

**Spec:** `docs/superpowers/specs/2026-09-18-unified-undo-delivery-design.md`

## Global Constraints

- Node 24.20.0、pnpm 11.19.0；沿用现有依赖与锁文件。
- Windows 本机、单用户、中文界面；只监听 127.0.0.1。
- 保留模型接口配置；不得读取或输出真实密钥，不发起真实模型调用。
- 用户练习数据不作为测试数据；只在备份及迁移验证后升级原库，不替用户批准草案或修改业务记录。
- 不新增“本机 · 私密 · 可撤销”或类似演示作品标语。
- 所有业务写入保留 owner 隔离、事务、版本检查、幂等重放及审计边界。

## Execution context

The user explicitly delegated continuous execution and waived further intermediate approval/manual-testing gates. Existing linked worktree: `C:/Projects/Goal-Coach`, branch `feat/local-goal-coach-mvp`. Do not merge/push or replace the original worktree. No installs. Read AGENTS.md and relevant installed Next docs before code.

Use `node` and pnpm's `C:/Users/YOUR_USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs`. Direct focused tests: `& 'node' node_modules/vitest/vitest.mjs run <test files>`. Typecheck: same Node plus `node_modules/@typescript/native/bin/tsc --noEmit` (no `.js`). Git commands use exact command-local safe.directory, never global. Controller owns commits, production builds, E2E/server lifecycle and practice backup; implementers do not touch a running server or data/.

Task 1 is deliberately one integrated deliverable: its schema, replay, analysis and UI contracts must remain coherent, and separating them creates unusable intermediate public interfaces. Task 2 is independently testable delivery tooling/documentation. Root performs final system verification after both reviews.

### Task 1: Unified reversible feedback end to end

**Files:**
- Modify: `src/core/domain/contracts.ts`, `src/server/db/schema.ts`, `drizzle/meta/_journal.json`; create next migration and corresponding snapshot under `drizzle/`.
- Modify: `src/server/repositories/repository-inputs.ts`, `repository-types.ts`, `repository-internals.ts`, `support-repository.ts`, `support-data.ts`, `conversation-repository.ts`.
- Modify: `src/server/operations/undo-service.ts`, `src/server/services/tool-handlers.ts`, `task-service.ts`, `service-contracts.ts`, `workspace-projection.ts`, `service-container.ts`. Verify the existing `task-execution.ts` consumer; change it only if its shared context contract requires an update.
- Modify: `src/server/agent/tool-contracts.ts`, `tool-executor.ts`, `tool-registry.ts`, `domain-write-observer.ts`, `context-builder.ts`, `conversation-compactor.ts`, `orchestrator.ts` and its focused tests.
- Modify: `src/lib/public-api-schemas.ts`, `src/server/services/data-service.ts`, `src/components/workspace/goal-workspace.tsx`, existing UndoBanner component; related typed fixtures/tests as required.
- Test: focused new migration/unified-undo tests plus existing repository, service, context, compactor, API, component tests; create `e2e/unified-undo.spec.ts`.
- Optional focused helper modules: `src/server/operations/undo-candidate.ts` for shared eligibility; `src/server/repositories/conversation-fence.ts` for snapshot/fence selection. No unrelated refactors.

**Interfaces:**
- Persisted CheckIn adds `withdrawnAt: string | null` (default null on parse for old operation results; never accepted on creation).
- Persisted UndoRecord adds `kind: 'task_execution' | 'check_in'`, nullable taskId/checkInId and positive `ordinal`; preserve old patches/IDs/undoneAt. Add nullable conversation-fence metadata sufficient to capture the last message ID at feedback withdrawal; server-managed, no user text. A JSON metadata field or narrowly scoped column is acceptable; precisely document the chosen representation in the report.
- `UndoResultSchema = z.union([z.object({ task: TaskSchema }).strict(), z.object({ checkIn: CheckInSchema }).strict()])`; export client-safe shared schema/type. Old task results remain unchanged.
- `undo_last_change` args retain goalId and add optional `expectedUndoId: uuid`, `expectedGoalVersion: positive integer`, both or neither, absent keys remain absent before hashing. New UI always sends both. Legacy unbound calls retain transactional latest semantics and exact replay.
- Workspace supplies `undoCandidate: { id: string; kind: 'task_execution' | 'check_in'; label: string } | null` and `undoUnavailableReason: string | null`, alongside canUndo. Model context gets candidate ID and current goal version to bind explicit tool calls.
- Support repository gains `withdrawCheckIn(ownerId, id, expectedVersion, withdrawnAt)` (sets marker, bumps goal, preserves content) and enough ledger access for candidate/fence lookup. Choose typed method names consistently across definitions/callers. Creation of feedback and ledger is atomic, exactly once.
- Conversation snapshot/compaction use the persisted withdrawal fence. A compaction started before fence change must be rejected at compare-and-replace; old stored messages/summaries remain available as history/export, not current model context.

- [x] **Step 1: Write observable failing tests, using existing real SQLite/service fixtures.** Start with a service test based on `setup`/`approvedGoal` in services.test.ts (new file may duplicate a small setup or extract a test-only helper):

```ts
const { services } = setup();
let w = await approvedGoal(services);
const checkIn = await services.tasks.recordCheckIn(owner, w.goal.id, {
  taskId: w.tasks[0].id, kind: 'blocker', blockerCategory: 'cannot_start',
  note: '需要先拆分步骤', minutesSpent: null, availableWeeklyMinutes: null,
  expectedGoalVersion: w.goal.version, operationId: randomUUID(),
});
w = await services.goals.getWorkspace(owner, w.goal.id);
expect(w.canUndo).toBe(true);
const request = { operationId: randomUUID(), expectedUndoId: w.undoCandidate!.id,
  expectedGoalVersion: w.goal.version };
const result = await services.tasks.undo(owner, w.goal.id, request);
expect(result).toMatchObject({ checkIn: { id: checkIn.id, withdrawnAt: expect.any(String) } });
expect(await services.tasks.undo(owner, w.goal.id, request)).toEqual(result);
expect((await services.goals.getWorkspace(owner, w.goal.id)).replanTriggers)
  .not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unresolved_blocker' })]));
```

Add real mixed task/feedback LIFO; stale guarded request must leave both entities untouched; withdrawn raw history/export persists; approved plan ID/tasks unchanged after feedback withdrawal.

- [x] **Step 2: Run focused RED.** Run the new tests before implementing and record the missing-behavior failures, not compiler/import mistakes. Test old-schema migration by executing the unmodified 0000 SQL into a disposable SQLite fixture, then migrating with its applied journal state. Seed task undo and feedback with equal timestamps, old succeeded task undo/check-in operation JSON, and an already-undone task row. Assert legacy identity/result hashes remain unchanged, feedback rows acquire markers/logs and ordered undo works after repeated migration. Use existing migration loading helpers or direct SQL fixtures, never the practice database.

- [x] **Step 3: Implement persistence and transaction semantics.** New writes allocate ordinals inside the existing transaction. Migration assigns `row_number() over(partition by owner_id, goal_id order by created_at, source_rank, source_rowid)`; use task rank 0, check-in rank 1. Preserve UUID validation for generated legacy feedback undo IDs. Database CHECK constrains exactly one target; unique per-goal ordinal and check-in target; foreign keys and repository owner/goal checks. Deletion order must remove undo before check-in. Withdrawal and undo record marking roll back together on injected failure.

```ts
// Both branches run in the existing executeOnce transaction.
const candidate = support.getLatestPendingUndo(ownerId, goalId);
// Validate bound ID/version when present, permissions/state and candidate eligibility.
// Task branch restores status/actualMinutes only after forward-state/current-plan checks.
// Feedback branch retains original record and marks withdrawnAt; records conversation fence.
// Mark the same undo record undone, reconcile derived signals, return shared union result.
```

Implement the two concrete branches in UndoService; no generic arbitrary JSON patch executor. Keep newest pending record authoritative; never skip stale task changes. Unit tests must observe returned/restored records and the absence of partial writes, not only method call counts.

- [x] **Step 4: Wire active projections and conversation safety.** Filter withdrawn check-ins before existing lineage logic. Use the same effective projection for real/model context, mock snapshots and review blockers. Capture message boundary transactionally on feedback undo; filter prior messages and summaries out of subsequent model contexts; allow post-boundary messages/summary compaction; reject in-flight pre-boundary compaction. Add tests with distinctive withdrawn text in both summary and messages, subsequent new text still present, and a deterministic concurrent compaction barrier. Do not call a model on undo. Advance export schemaVersion to 2 and retain history markers. Existing historical operation JSON stays byte-for-byte untouched.

The orchestrator currently caches a turn's messages. After a successful undo tool, stop the batch and use the existing turn-store success path with a deterministic acknowledgment (no withdrawn text); do not send the tool result/old messages to another model iteration and do not compact. Cover a model-proposed undo followed by another write in one batch: only undo commits, there is no second model call or later-tool mutation, and stored acknowledgment is safe. Both undo result variants follow this rule.

- [x] **Step 5: Wire the existing UI and E2E.** Use shared result validation, unified label, candidate description, disabled reason, bound mutation inputs and existing mutation lease/idempotent recovery. Clearly distinguish withdrawn feedback in a compact history view; old advice must not remain styled as the current recommendation after undo. Existing saved reflection requires visible historical/data-changed status when its input became stale. Add component tests for feedback result and stale response; add a browser flow that creates a disposable goal, changes a task, submits feedback, undoes feedback first and task second, reloads, and verifies history/plan preservation. Root runs E2E later; worker does not start/stop server.

- [x] **Step 6: Run GREEN and self-review.** Focused tests during iteration, then all Vitest tests, ESLint and typecheck once. Record commands, counts, expected failures and warnings. Report changed files and any uncertain edges. Do not build or run E2E. Controller stages exact files and commits `feat: unify task and feedback undo with safe history` after verifying results.

### Task 2: Safe local launcher, source handoff and documentation

**Files:**
- Create: `scripts/local-app.mjs`, `scripts/package-source.mjs`, `scripts/local-app.test.mjs`, `scripts/package-source.test.mjs`, `docs/delivery/README.md`. Native JavaScript tests avoid declaration stubs solely for strict TypeScript imports of CLI helpers.
- Modify: `package.json` scripts only, `.gitignore`, `eslint.config.mjs`, `vitest.config.ts`, `tsconfig.json` to exclude generated `dist/` from source checks/tests; `README.md`, `docs/learning/free-practice.md`, `docs/learning/README.md`, original local spec's known-gap disposition, `docs/verification/local-mvp-acceptance.md` current-status paragraph (preserve dated evidence).
- Root after verification creates: `docs/delivery/verification-2026-09-18.md` with actual evidence, no anticipatory success claims.

**Interfaces:**
- `node scripts/local-app.mjs check` is read-only: exact pinned Node check, local package presence (Next/SQLite), compiled build presence, port availability; reports actionable Chinese diagnostics without reading .env content or installing/killing anything. Check command may report build absent and return nonzero, never writes it.
- `node scripts/local-app.mjs start` fails closed on wrong Node, missing build/dependency or occupied port, otherwise runs installed Next with `start --hostname 127.0.0.1 --port 3000` in foreground with inherited environment, routes Ctrl+C to owned child and does not kill unrelated listeners. Respect explicit DATABASE_PATH; Next handles existing .env loading normally. Do not copy/overwrite config or force persisted provider selection.
- package scripts `local:check`, `local:start`, `package:source` invoke these Node entrypoints.
- `node scripts/package-source.mjs` creates a new versioned source directory under dist/ and a JSON SHA-256 manifest. Use an explicit top-level file/directory allowlist, recursive symlink rejection and forbidden private/generated path checks. Output includes .env.example only, never another .env file. No automatic upload or dependency install. Refuse overwrite of an existing output directory.
- Exports needed for isolated tests may accept a temporary project root; CLI resolves its own project root. Test injections must not bypass real effects under test.

- [x] **Step 1: Write RED using temporary directories and real subprocess/filesystem behavior.** For packaging, create source fixtures plus `.env.local`, `data/secret.db`, logs, symlink escape and fake node_modules; assert allowed bytes/manifest hashes copied and private/generated entries absent; symlink and existing-output requests fail without altering the destination. For local check, use controlled fixture dependencies/build and an occupied local socket; assert refusal exit/status and no listener killed, no .env contents in stdout/stderr and no file changes.

```ts
const result = spawnSync(process.execPath, [scriptPath, 'check'], { cwd: fixtureRoot, encoding: 'utf8' });
// Exercise exported preflight with fixture root when CLI intentionally pins its own root.
// Assert nonzero when incomplete; bind a test-owned socket and verify it stays open after refusal.
expect(result.stdout + result.stderr).not.toContain('synthetic-private-sentinel');
```

Use literal expected allowed file names and independently computed Node crypto hashes of known fixture bytes. Do not test source-code string inclusion.

- [x] **Step 2: Run RED, implement minimal helpers, run GREEN.** Built-in Node fs/path/net/child_process/crypto only; no packages or PowerShell execution-policy changes. Preflight uses `process.versions.node`, `createRequire` rooted at project package, `existsSync` build manifest and exclusive bind probe. Packaging uses lstat/copyFile with stable file ordering and `createHash('sha256')`, validates destination stays inside project dist, and returns manifest without including secrets. Provide a source directory rather than falsely naming it an executable release; root may zip it with native Compress-Archive for convenience.

Exclude `dist/**` from Vitest and ESLint and `dist` from TypeScript as well as Git: a generated source copy must never be rediscovered as application sources/tests. Demonstrate this by placing an intentionally invalid test/source sentinel in a temporary dist during a focused configuration behavior check, then removing only that owned sentinel; do not modify a real release folder. Do not add a source-text grep test for config syntax.

- [x] **Step 3: Update human docs.** Document launcher commands, source installation prerequisites, lifecycle, 127.0.0.1 boundary, SQLite backup/restore (stop server before copying full DB/WAL/SHM or use SQLite backup), unified undo and legacy tie ordering, schemaVersion 2, historical feedback/advice, no-key mode limits and deferred real model/public deployment. Replace obsolete M3-current-gap claims only after Task 1 reviewed; preserve original dated review history. No mandatory user practice checklist. Do not claim clean-OS installation based on this machine's tests.

- [x] **Step 4: Focused helper tests, full test suite, lint/typecheck and self-review.** Do not start actual server, build, package private data, install, push or deploy. Provide test evidence and exact paths. Controller commits `feat: add safe local launch and source delivery tools` after verification.

## Controller final acceptance

- [x] Read task reports and independent task reviews; fix findings through the original worker and scoped review.
- [x] Verify retained server identity; stop only that owned process tree. Back up the retained practice SQLite consistently and record its row-count/version baseline without printing private notes.
- [x] Run `pnpm verify`, isolated `pnpm e2e`, `pnpm eval` serially; investigate failures with evidence. Do not use any live evaluation command.
- [ ] Exercise local preflight failure/success and source packaging on current output; inspect manifest for private/generated entries. Produce archive and SHA-256 after final commit, using explicit validated paths.
- [x] Run one whole-branch review for this delivery increment, one integrated final fix wave and scoped review if needed. Record factual residual limitations; never hide them with a complete claim.
- [x] Restore updated production server on the same practice database only after migration tests and backup; verify migration/data counts, original pending draft preserved, homepage and read-only goal GET. Model remains inactive.
- [ ] Save dated verification report, exact run outcomes and known limitations; hand off working URL, launch command, source artifact and concise remaining external boundaries. Do not merge/push or create a public URL.
