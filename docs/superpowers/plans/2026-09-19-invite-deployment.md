> 历史设计/执行记录，保留当时决策；路径已匿名化。当前行为、默认值和发布权限以仓库当前规格及本次发布说明为准。

# Invite Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Qwen integration and deliver an invite-only, isolated multi-user application with deployment artifacts and a complete Chinese guide, without credentials or public deployment.

**Architecture:** Keep local mode and existing repository ownership. Add database-backed invitation/password/session auth for invite mode, enforce identity at every API and model limits in the service boundary, then package a single-instance Docker/Caddy/SQLite deployment.

**Tech Stack:** Existing Next.js / React / TypeScript / Zod / better-sqlite3 / Drizzle, Node crypto, Docker Compose and Caddy.

**Spec:** docs/superpowers/specs/2026-09-19-invite-deployment-design.md

## Global Constraints

- Node.js 24.20.x、pnpm 11.19.x，现有依赖锁定；不升级运行时或框架。
- 不读取或输出 .env.local、API Key、真实用户数据库内容；验证使用独立临时数据库。
- 不出现“本机 · 私密 · 可撤销”等展示样机式标语；必要的状态、隐私与错误提示保留。
- 模型默认 mock，DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL 保持空白；无真实模型网络请求。
- 本机模式与邀请模式明确隔离，公网部署只允许邀请模式，数据存储为单实例持久化 SQLite。
- 每个任务遵循测试先行，审查后推进；不合并、推送或对外发布。

## Execution and environment

Preserve user's chosen subagent-driven method; user explicitly requested continuous ownership instead of repeated gates. Worktree: C:/Projects/Goal-Coach, existing feature branch. Node: node. pnpm CLI: C:/Users/YOUR_USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs. Git: D:/ProgramData/Git/cmd/git.exe with command-local safe.directory. Use apply_patch for edits. Do not stop the existing port 3000 practice process. Tests must not use its database. Run focused TDD tests while iterating and full `pnpm test` before task completion. Read AGENTS.md and installed Next documentation before code.

## Review Focus

- Existing saved Qwen settings with absent credentials must fail safely without losing data; Task 1 checks read-only readiness and sanitized transport errors.
- Parallel redemption and disabled/expired sessions must not authenticate; Task 2 uses a real temporary SQLite database.
- Guessing another user's IDs including operation/draft/export/clear must not bypass auth; Task 3 exercises all protected route families.
- Replays, simultaneous goals and low limits must not cause duplicated provider admission or quota bypass; Task 3 tests actual service execution using a deferred fake external model.
- Backups with WAL data and restore into existing files must preserve data or refuse safely; Task 4 executes scripts against a synthetic DB. Task 5 exercises real browser sessions and documents environment gaps.

### Task 1: Qwen readiness and explicit safe request controls

**Files:** Modify src/server/config/env.ts, env.test.ts, src/server/agent/qwen-client.ts, qwen-client.test.ts, src/core/errors/app-error.ts, src/components/settings/model-settings.tsx and its tests; create src/server/agent/model-readiness.ts and .test.ts, src/app/api/settings/model-readiness/route.ts, src/components/settings/model-readiness.tsx and .test.ts; update .env.example and src/app/settings/page.tsx integration as needed.

**Interfaces:** Consumes ServerEnv and existing apiResponse/local owner pattern (Task 3 replaces at HTTP edge). Produces `getModelReadiness(env: ServerEnv, provider: 'mock'|'qwen')` returning safe booleans/status/models only. `ServerEnv` gains optional `qwenMaxOutputTokens?: number` (default resolution 2048), preserving existing direct object fixtures. No external health-call endpoint required: only non-network configuration check in this release; document real test command later rather than introducing an unmetered billing endpoint.

- [ ] Step 1: Add failing behavioral tests for absent Key/Base URL, configured-but-not-verified status, per-call controls and safe classification. Example assertions:
```ts
expect(getModelReadiness(loadServerEnv({}), 'mock')).toMatchObject({ configured: false, liveVerified: false });
await expect(client.complete(request)).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED' });
```
  Fake the external OpenAI transport only; capture outgoing body and assert `enable_thinking:false`, `max_completion_tokens:2048`; never call a live endpoint.
- [ ] Step 2: Run focused Vitest files and record the expected failures.
- [ ] Step 3: Implement offline readiness, safe UI wording and explicit Qwen controls. Use typed intersection/extension body for Node OpenAI extra field (not Python extra_body). Classify actual OpenAI API errors by status, never error.message: 401/403 auth, 404 model unavailable, 429 rate limit, connection errors unavailable; preserve timeout and malformed response handling. No forced JSON response mode and no automatic model call on save/page-load.
- [ ] Step 4: Run targeted tests, full suite, typecheck and lint; update report with RED/GREEN commands.
- [ ] Step 5: Commit only this task's paths with `feat: prepare safe Qwen configuration and readiness` (controller may perform scoped Git commit if worker sandbox blocks).

### Task 2: Invite authentication foundation and management service

**Files:** Create src/server/auth/{auth-config,password,auth-store,auth-service,auth-contracts,auth-container}.ts and focused .test.ts files, drizzle/0002_invite_auth.sql and journal entry, scripts/auth-admin.ts; modify src/server/db/schema.ts (add auth table exports if using Drizzle), core/errors/app-error.ts, package.json (auth:admin command only). New focused helper files allowed when needed to keep units small.

**Interfaces:** Consumes existing database client/migration and AppError. Produces `loadAuthConfig(input=process.env): { mode:'local'|'invite'; origin:string; secureCookies:boolean }`, `getAuthService()`, `AuthService` with `register({inviteToken,username,password})`, `login({username,password})`, `authenticate(token)`, `logout(token)`, `createInvite(actor)`, `revokeInvite(actor,id)`, `listUsers(actor)`, `disableUser(actor,id)`, `listInvites(actor)`; authenticated actor `{ownerId:string,username:string,role:'admin'|'member'}`. Register/login return actor + raw session token only to HTTP adapter (not generic JSON); invite creation returns raw invitation once. Service may take DB/config/clock dependencies. CLI creates first admin invite, can reset password via stdin; no existing data automatically assigned to new accounts. Task 3 adds HTTP routes/UI using these contracts.

- [ ] Step 1: Write tests using real temporary migrated SQLite, including:
```ts
const invite = service.bootstrapAdminInvite();
const first = await service.register({inviteToken:invite.token,username:'Alice',password:'a long synthetic password'});
expect(first.actor.username).toBe('alice');
await expect(service.register({inviteToken:invite.token,username:'Bob',password:'another synthetic password'})).rejects.toBeDefined();
expect(service.authenticate(first.token)?.ownerId).toBe(first.actor.ownerId);
service.logout(first.token);
expect(service.authenticate(first.token)).toBeNull();
```
  Also test parallel consumption, expiry, duplicate username rollback, wrong password generic response, disabled user, reset revocation, admin-only management and no last-admin lockout, limited credential lengths, no plaintext persisted, retained legacy business rows, global/per-account limit before hashing. Use literal synthetic credentials only.
- [ ] Step 2: Run focused tests for expected RED; do not weaken production password parameters for tests.
- [ ] Step 3: Implement spec B using async scrypt and synchronous short SQLite transactions around only DB work. Session/invite hashes use SHA-256, raw tokens randomBytes(32). Do not hold transactions over await. Use SQLite tables for throttle counters; bounded expiry cleanup. Local mode config defaults to loopback origin, invite requires HTTPS except loopback. CLI input secrets via stdin, no password argument or logging; admin invite output intended for user's private terminal, never create one in user's database during development.
  Bootstrap guard ignores expired/revoked invitations so a lost expired bootstrap does not permanently prevent setup. Login must recheck password hash/user enabled state after awaited hashing, and only then issue a session, to avoid reset/disable races. Missing-user login performs bounded dummy verification to reduce timing-based enumeration. Username validation must not bypass global throttle. Limit global concurrent password jobs to two with immediate safe rejection (no unbounded queue). Tests exercise the real hash at least once and deterministic blocked hashing only for concurrency characterization.
- [ ] Step 4: Run focused auth/db tests, full suite and typecheck/lint; report exact API signatures for Task 3.
- [ ] Step 5: Commit `feat: add invite-only account and session foundation`.

### Task 3: Authenticated HTTP/UI, tenant isolation and admission limits

**Files:** Modify src/app/api/_shared/api-response.ts, all src/app/api/**/route.ts business adapters, src/server/security/origin-guard.ts and tests, src/server/agent/agent-turn-store.ts and tests, src/server/services/{service-container,settings-service}.ts and tests, src/components/layout/app-shell.tsx, src/components/settings/model-settings.tsx, src/app/settings/page.tsx. Create src/server/auth/request-identity.ts, src/app/api/auth/{session,login,register,logout}/route.ts, src/app/api/admin/{invites,users}/route.ts (subroutes if helpful), src/app/login/page.tsx, src/app/admin/page.tsx, src/components/auth/*, src/server/agent/admission-limits.ts and tests, src/app/api/invite.integration.test.ts. Modify lib/public-api-schemas.ts and API client only as needed for safe auth UI and optional capability flags.

**Interfaces:** Consume Task 2 actual actor/service APIs, Task 1 readiness endpoint. Produce `requireRequestActor(request)`; `apiResponse` resolves actor and passes it into callback; existing route callbacks replace fixed LOCAL_OWNER_ID with actor.ownerId. Auth public endpoints use a separate response helper with same Origin/body/safe-error checks, never an unchecked generic bypass. Pages may use client AuthGate/session endpoint; API is authoritative. Invite-mode settings effective provider/fallback/budgets derive from server env on every read/execution; sensitive PATCH rejected regardless of role, privacy consent remains writable.

- [ ] Step 1: Add two-user integration tests around actual route handlers using real auth DB and business repositories. Assert anonymous GET/export 401, forged body ownerId rejected, B cannot read/modify A's goal/task/draft/approval/undo or replay, B export excludes A, clearing B preserves A and auth identities. Example:
```ts
expect((await goalsGET(requestWithoutCookie)).status).toBe(401);
expect((await goalGET(bobRequest, {params:Promise.resolve({goalId:aliceGoalId})})).status).toBe(404);
```
  Add session cookie attributes, logout, member/admin gate, missing/wrong Origin and oversized/chunked body tests. Add service tests where two simultaneous goals for same owner produce one admitted model call, a third global call is rejected, and replay does not increment daily count.
- [ ] Step 2: Run new tests to demonstrate failure before implementing HTTP protection.
- [ ] Step 3: Implement adapters, login/register UI, logout/session gate, invite/user management UI and ordinary read-only server model settings. Preserve look/interaction style and local mode existing tests. Update data-control copy to say “当前账号数据” in invite mode where necessary, without falsely claiming cloud data stays on-device. Enforce 256KiB body cap by bounded stream reading, not only Content-Length. Origin compares configured exact canonical origin. Token/cookie/private credentials never in client logging, query URLs or generic errors. Keep existing data clear phrase compatibility where API tests depend on it; UI must accurately explain scope.
  Also modify src/server/agent/permission-gate.ts and its tests: replace the fixed local-user check with valid verified-owner UUID contract, preserving all source, intent, state, subject and approval-owner bindings. HTTP adapters establish trusted owner; tools never obtain it from model arguments. Test a nonlocal user can execute their own mock tool loop and cannot use another user's grant. Keep all full-binding tests.
- [ ] Step 4: Implement single-instance concurrency lease in service wrapper (per owner 1/global 2) with finally release; persistent daily new-turn counts with limit default 50 at admission, not provider completions. Accept replay of existing operation without consuming daily allowance; settings/data clear must not reset auth-bound quotas. Server env `DAILY_AGENT_TURN_LIMIT` controls limit (integer 1–1000), documented fixed global/per-user concurrency. Never count or invoke model before auth/ownership/consent validation. Explicitly document bill-cap limits.
  Server model policy must reach all consumers, not only public settings projection: UsageBudgetService reads persisted settings, and AgentTurnStore/current controls fallback. Synchronize effective cloud settings on get only when values differ, or inject one effective policy consistently into all consumers. Check consent server-side before any Qwen call (including direct API requests); mock mode remains available without transmitting data. Cloud privacy UI must state data is stored on the operator's server and sent to provider only when Qwen is enabled.
  Daily admission date uses Asia/Shanghai, matching existing token-budget calendar; it survives business-data clear. Runtime mode must not be baked into a build-time local bypass. Follow .superpowers/sdd/2026-09-19-invite-deployment/ui-notes.md for existing design/accessibility and session-state cleanup guidance.
  Invite-mode known token usage and per-attempt deduplication must also survive business-data clear; store content-free account/day/attempt usage independently of cleared operations (aggregate optional). Count known in-flight usage returned after clear without resurrecting cleared goals/conversations/settings/runs; workspace-generation cancellation still prevents business updates. Keep existing local clear/reset behavior. Add real SQLite tests for clear/recreate, duplicate settlement across clear and delayed settlement after clear. UI/guide explicitly disclose retained account/security/usage records, containing no goal/chat content.
- [ ] Step 5: Run focused tests + all tests + lint/typecheck; self-review every API file and Agent admission. Commit `feat: isolate invited users and protect model admission`.

### Task 4: Repeatable deployment and safe maintenance scripts

**Files:** Create Dockerfile, .dockerignore, compose.yaml, deploy/Caddyfile, deploy/.env.example, src/app/api/health/route.ts, scripts/database-backup.mjs, scripts/database-restore.mjs and .test.mjs, scripts/deployment-check.mjs and tests if needed; modify next.config.ts, package.json commands, scripts/package-source.mjs/tests to include safe deploy artifacts. Create docs/deployment/README.md and docs/deployment/operations.md.

**Interfaces:** Consume APP_MODE, APP_ORIGIN, auth admin command from Tasks 2–3, Qwen settings from Task 1. Produce `pnpm db:backup -- <new-path>` and `pnpm db:restore -- <backup> <new-db-path>` with non-overwriting semantics; `docker compose up -d --build`, internal `/api/health`, env sample and admin setup commands that work inside Linux image. One Node process only, SQLite path `/app/data/goal-coach.db`, Caddy persistent cert/data volumes, no public 3000 binding. Runtime CLI must resolve dependencies under built image, not assume dev-only executables absent from image.

Release artifact version is 0.2.0 (package.json application version only; no dependency upgrades), since dist/goal-coach-agent-source-v0.1.0 already exists and must not be overwritten. Current pnpm-workspace.yaml denies dependency builds; explicitly rebuild only better-sqlite3 in Linux image using its package script/toolchain, not blanket enabling all lifecycle scripts. Include deploy/.env.example via a narrow packaging exception without admitting arbitrary nested .env files.

The source-package allowlist must also include Task5's forthcoming `playwright.invite.config.ts` and `e2e-invite/`; test those entries using fixtures so the final package contains its documented invitation acceptance commands.

- [ ] Step 1: Write executable backup/restore tests, using synthetic WAL database. Run scripts, reopen output and assert rows/FK/integrity. Existing destination must return nonzero and remain byte-identical; bad source must not create valid-looking output. Source packaging tests must exercise produced archive listing (no private .env/db/logs).
- [ ] Step 2: Observe RED for absent backup/restore behavior; implement using SQLite backup API, readonly validation and exclusive destination creation. Do not remove arbitrary output paths on failure. Document restore to a fresh volume with app stopped.
- [ ] Step 3: Implement pinned Linux multi-stage/nonroot Docker build with native SQLite build prerequisites, frozen pnpm lockfile, runtime migration/auth/maintenance support. Keep standalone dependency tracing verified or choose full production install if more reliable. Caddy terminates HTTPS; set secure headers, request body limits/timeouts consistent with Agent worst-case. Docker health uses Node fetch only local endpoint. Compose forces invite mode and keeps blank Qwen config valid.
  As required by design section D, `/api/health` validates local configuration and database connectivity, not a constant process-alive response. Use a read-only, non-creating database check; failure returns safe503/no-store without path, Key, counts or raw errors. It never calls a model, mutates schema or migrates a database. Mock with blank credentials remains valid.
  Read-only recheck on 2026-09-19 found no port-3000 listener and no old PID 7792. A later existence-only check found `.env.local` present (contents not read). Build verification therefore runs in a fresh allowlisted source copy without private env/data, with synthetic blank-key/database environment; retain normal `.next` inside that copy. Do not rename/remove the original private file or add a production distDir option solely for validation. Existing dependencies can be linked for Windows validation; installed Turbopack docs require root to include linked dependencies, so a copy-only explicit root configuration is acceptable if documented, without changing application behavior. Record any such harness-only difference. Task5 reuses this approach for full E2E; no original database/process is touched.
- [ ] Step 4: Add Chinese deployment/maintenance docs covering config, admin invitation, password recovery, account disabling, invitation revocation, quotas, backup/restore, rollback without downgrading migrated DB, source transfer excluding secrets and user data. Explicitly separate runtime-verified and template-only steps. If Docker unavailable, record the missing executable and do not claim container validation.
- [ ] Step 5: Run maintenance/script tests, all tests + lint/typecheck/build when safe, source packaging tests; commit `feat: package invite deployment and safe database maintenance`. Exercise packaging in synthetic fixture roots here; reserve the real non-overwriting v0.2.0 delivery directory for after Task 5 and the final review so it includes the completed guide and acceptance tests.

### Task 5: Integrated acceptance and beginner end-to-end guide

**Files:** Create playwright.invite.config.ts, e2e-invite/invite-flow.spec.ts plus synthetic setup helpers, docs/delivery/verification-2026-09-19.md, docs/deployment/full-guide.zh-CN.md; update README.md, docs/delivery/README.md and minimally docs/learning/README.md with current local/invite boundaries. Fixes outside this scope reported to controller for review, not silently omitted. Controller guide-outline.zh-CN.md in the plan scratch workspace supplies a beginner-oriented structure to verify against final code, not claims of passing acceptance.

**Interfaces:** Consume completed app/UI/scripts. Produce reproducible browser tests using isolated temporary DB/port, root project verification commands, and one linked Chinese guide including present delivery state, local use, server/domain/config/deploy, account invitation, future Qwen activation, costs/privacy/operations and acceptance checklist.

Acceptance-discovered scoped correction approved on2026-09-20: `src/components/auth/login-form.tsx` HTML pattern contains an unescaped hyphen rejected by Edge's Unicode-v pattern parser. Escape only that hyphen, preserve the server username rule, and add real browser checkValidity assertions for allowed ASCII letters/digits/underscore/hyphen and rejected dot/non-ASCII names plus clean console/pageerror evidence. This is a compatibility fix, not a new form feature.

- [ ] Step 1: Add browser story: admin invitation → registration → admin creates member invite → separate browser member registers → goal created → other account cannot see/read it → logout invalidates API → blank model configuration shows not configured and no network model call. Synthetic DB only; never connect to existing 3000 practice DB.
- [ ] Step 2: Execute browser story and existing local E2E on isolated app instances; run lint/typecheck/full unit/build and 30-case mock eval with model network blocked/credentials explicitly blank. Record commands, output counts, exit codes and limitations. Run Docker only if installed/usable; no download/installation of Docker or real cloud resource provisioning.
  Existing e2e/global-setup.ts hardcodes 3000; parameterize its port and playwright.config.ts plus any hardcoded spec Origin together using a validated E2E_PORT with current 3000 default. Tests target the isolated selected APP_ORIGIN; refuse preexisting listeners and terminate only owned child processes. Run this turn's browser suites from the private-env-free source copy described in Task4, not original cwd. No reuse of the practice listener.
- [ ] Step 3: Write complete guide with commands copied from actual artifacts, safe credentials handling and no claims of public deployment/live Qwen verification. Include “not yet executed: live Qwen, real DNS/TLS/cloud restore and container build if unavailable.” Explain free mock limits and that provider configuration is global in invite mode.
- [ ] Step 4: Commit `test: verify invite delivery and document end-to-end launch` and report all evidence for final whole-change review. Do not replace or restart user's original practice process in this task. The controller creates and verifies the final versioned source package after review; no earlier task should consume that immutable output name.
