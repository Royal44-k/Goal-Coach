> 历史设计/执行记录，保留当时决策；路径已匿名化。当前行为、默认值和发布权限以仓库当前规格及本次发布说明为准。

# Goal Coach 全量验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可复现证据验证并修复真实模型完整目标闭环，形成可本机使用的版本与如实标明外部准入条件的部署交付。

**Architecture:** 保留现有 Next.js、SQLite、服务层、受限工具和可信 UI 审批。新增仅供验收使用的 lifecycle runner，串联同一合成目标的所有阶段；生产缺陷先复现再局部修复，不靠手动伪造草案、放松校验或无限重试通过。

**Tech Stack:** Node.js 24.20.x、pnpm 11.19.x、TypeScript、Vitest、Playwright、DeepSeek、SQLite。

**Spec:** `docs/superpowers/specs/2026-09-24-deepseek-pwa-design.md`；当前用户 2026-09-27 明确授权全量验收及必要 DeepSeek 请求，不再受之前 5/20 或 2/8 批次限制。本条取代原规格的“本批次不发真实模型请求”，不改变秘密隔离与产品运行安全约束。

## Global Constraints

- Node.js 24.20.x、pnpm 11.19.x，沿用当前锁定依赖，不升级框架、不重装现有 node_modules。
- 秘密只由根 Agent 的显式 live 进程私下读取；不得输出 .env.local/Key，子 Agent 不读取密钥、不执行付费调用。
- 测试使用合成输入、内存或独立自有临时库；原练习库与 3000/3400 用户实例不作为测试对象。
- 保留现有身份隔离、Origin 校验、统一撤销、审批、单回合工具/请求限制和配额保护，不用“请求不限”移除产品防护。
- 模型不能批准结构变更；验收程序只能通过现有可信 UI 服务入口模拟批准，不直接改业务库绕过状态机。
- 默认 mock；live 必须显式 opt-in。记录每次实际请求、已知/未知用量、失败阶段；只对有具体原因的修正执行复验，不盲目重跑到绿。
- 不购买云资源、不公开发布、不上传秘密或真实数据库、不 push/merge；缺少目标主机或真机时不得冒充云端/真机验收。
- 不出现“本机 · 私密 · 可撤销”等展示样机式标语。
- 工作区已有前序修改，保留原样；任务实现阶段不提交混合历史改动，由根任务统一交接版本。

## Review Focus

- 草案虽合法但文字与落库假设不一致：结果记录完整合成草案及回复以供内容核查（Task 1）。
- 无草案却宣称成功、截断、重复无效工具：必须使该阶段失败且停止依赖步骤，不注入手写草案“救绿”（Task 1/2）。
- 计划重排丢失完成证据或撤销跨版本误用：用真实服务与数据库断言保留记录（Task 1/2）。
- 同一操作重放意外再次付费：以同 operation ID 验证无新模型请求（Task 1）。
- 邀请浏览器请求取消和环境报错被当作无害：保留诊断、明确原因/未复现，部署证据分层（Task 3）。

---

### Task 1: 可离线自测的真实生命周期验收器

**Files:** Create `evals/lifecycle-run.ts`, `evals/lifecycle-scenarios.ts`, `evals/lifecycle.test.ts`; optionally a focused `evals/lifecycle-support.ts` if needed. Reuse `evals/run.ts` observer and `evals/tool-diagnostics.ts`; do not modify production code in this task.

**Interfaces:** `runLifecycleEvaluation(options)` accepts provider `mock|deepseek`, explicit `allowLive`, scenario `learning|light_work|all`, optional `outputDir` and loaded `ServerEnv`. Returns per-scenario result paths, pass/fail counts and aggregate actual provider calls/token counts. CLI requires `--provider=deepseek --allow-live` before loading private config; default mock never reads private env. Scenario data uses current/explicit fixed evaluation clock, not September 17 by accident.

- [x] Write behavior tests: unapproved live rejects before output/config/model; both mock scenarios traverse full real services; failed draft stops subsequent approval/plan/completion; same-op replay consumes no provider request; reports include stage error and full effective draft without credentials.
- [x] Run focused tests RED and record actual failures.
- [x] Implement two fixed synthetic scenarios: learning goal and light-work goal, explicit outcome/observable deliverable/deadline/capacity. For each: create → consent → real Agent contract draft → assert no formal change → trusted contract approval → Agent plan → assert pending/non-mutating → trusted plan approval → UI execution change + unified undo → UI evidence completion for one task → record blocker/availability change → Agent blocker advice → Agent replan → verify pending and preserved completed evidence → trusted replan approval → complete remaining tasks with clearly synthetic evidence → Agent review using application review request → trusted completion → owner export. Re-read workspace/version at each action. Natural prompts must not carry handcrafted tool arguments. Do not silently replace missing model output with fixtures in live mode.
- [x] Record model calls by stage, elapsed time, sanitized argument diagnostics, safe error code, replies, full saved synthetic contract/assumptions and plan details, before/after structural invariants. Save failure evidence even when stopping a scenario. No raw private env/request headers. Results under unique `evals/results/lifecycle-...` (existing package/git exclusion).
- [x] Test mock mode against real service/container/SQLite/state machine, with only model transport replaced; include intentionally invalid model output to prove harness can fail. Offline tests must not require or dispatch real DeepSeek. Run focused tests GREEN, typecheck, then full Vitest (CLI sandbox-limited tests may run separately). Do not commit mixed user work or run paid tests.
- [x] Independent task review before live execution.

### Task 2: 真实场景执行、定位与局部修正

**Files:** Consume Task 1 runner; modify only evidenced affected files under `src/server/agent/`, `src/server/services/`, `src/lib/` and covering tests when defects are reproduced. Update `docs/delivery/full-acceptance-2026-09-27.md`.

**Interfaces:** root alone loads private config and runs `runLifecycleEvaluation`; per-stage artifacts identify exact contract boundary and provider usage. Existing public service contracts remain authoritative.

- [x] Preflight current Node/config/official host/key presence without echoing key; execute learning then light-work live flows, record actual counts (no inherited 2/8 batch stop).
- [x] On failure read actual field diagnostics and state, reproduce offline with synthetic equivalent, then dispatch focused TDD fix and review; do not weaken permission gates, schema validation or semantic success conditions.
- [x] Re-run failed flow after confirmed fix, then run the other flow. Compare content with goal/capacity/evidence, not just a machine boolean. Additional robustness scenarios may target the specific old repeated-tool failure without pretending unlimited coverage.
- [x] Retain failing artifacts alongside successful ones, and distinguish API/service live coverage from browser mock coverage.

### Task 3: 集成、浏览器、部署与交付核验

**Files:** existing `e2e/`, `e2e-invite/`, `scripts/`, `Dockerfile`, `compose.yaml`, delivery/deployment docs; new acceptance report.

**Interfaces:** consume verified product changes from Task 2; isolated production source preview, owned test ports, mock/external network blocker for free browser suites. Read-only environment audit may run alongside Task 1.

- [x] Check Docker/WSL availability and explicit cloud/deployment inputs without reading secrets or installing system components; actual Linux/HTTPS/phone tests require real target, report missing conditions once at handoff.
- [x] Run fresh lint/typecheck/all unit+integration+CLI/mock evaluations; build isolated production source and run full local/invite/PWA E2E with persisted diagnostics. Reproduce failures scientifically, never filter unknown aborts.
- [x] Validate backup/restore scripts using only disposable synthetic data, runtime restart persistence, non-disclosure, invitation isolation and consent/quotas using existing integration/E2E coverage.
- [x] Independent final code review, verify resulting runnable local preview, package new version only with correct manifest/source equality and no private env/data; do not overwrite 0.2.0/0.2.1 snapshots.
- [x] Update beginner guide and acceptance matrix: pass/fail/unrun, exact calls/tokens, local start path, deployment prerequisites. Local software completion does not imply public launch, true-phone testing or proven commercial value.

## Self-review

2026-09-27 amendment after 08:28Z content review: both live flows mechanically passed at4096, but light_work merged/reworded tasks and cut unfinished280→175 minutes without evidence, evading exact-work matching; it also omitted routing the starter sample into the catalog. Add a conservative model-only aggregate unfinished-estimate floor at both adapter and transaction guard: regardless of rewording, total proposed unfinished effort cannot drop below the trusted current unfinished total. Retained done/skipped excluded; reset work counted; no manual-path restriction. This intentionally refuses autonomous efficiency discounts, not a claim of semantic or true-effort proof. Genuine estimate reductions can be explicitly reviewed using existing manual revision, not silently inferred. Preserve completed/deadline/exact checks and shared single repair. Prompt must carry starter output into downstream delivery/verification. Extend only the explicitly named time-choice continuation to light_work (restore180, not pretend90 works), keep default scenarios untouched and add independent harness effort-floor assertion. The additional capacity attempt at08:30failed known UUID format twice; add static known-UUID repair guidance, not schema relaxation or a blind paid retry. Rootowns harness/docs; sole implementerowns seven affected production/test files. Independentreview required beforelive.

2026-09-27 amendment after 07:36Z: the exact-work guard prevents unsupported discounts, and learning now honestly refuses a too-small capacity without changing formal state. The strict all-stages runner correctly remains failed, but needs a separately named, explicitly predeclared synthetic user-choice continuation to cover conflict resolution; never silently restore the half-time budget or count refusal as completed lifecycle. The saved initial plan totals 960 minutes while the free-form acknowledgement says 11.5 hours, so replace plan/replan save acknowledgements with deterministic persisted-draft facts and stop the redundant model summary call, preserving all turn/fence/ownership/accounting gates. A known unresolved planning constraint followed by a no-tool response should give a precise server-authored constraint notice, not fabricated choices that weaken the accepted outcome. Shared repair budget, schemas, manual choices, and model-authored substantive planning remain unchanged. Add RED/GREEN tests and independent review before another paid batch.

2026-09-27 Task 2 amendment after 07:12Z: prompt-only grounding still allowed exactly unchanged learning-task action/doneCriteria with reduced estimates. Add a narrow model-only exact-work estimate conservation rule to the existing adapter and transaction guard, using the existing shared single repair. Same-ID source matching is authoritative; changed IDs are compared only when unmatched unfinished source and new proposal text keys are each unique. Duplicate/ambiguous text is outside this narrow rule, not guessed by first-match; keep explicit tests and independent lifecycle checks. No semantic-scoring model, new proposal schema, automatic estimate editing, or manual-path restriction. Changed wording is not proof of real efficiency and still requires content review. Retain prior artifacts and original scenario requirements.

2026-09-27 Task 2 content amendment after 06:49/06:51 live runs: numerical capacity, dates, evidence preservation and arithmetic passed, but both replans cut unchanged work estimates without explaining an efficiency/quantity basis; the learning "small step" remained inside a large composite task. Refine planning guidance to state estimation assumptions, require a concrete workload/method/record-based reason for reduced estimates, and make task-too-large advice into a separately completable short task. Do not introduce a new model/scoring service, schema or broader authority; infeasible work may require an honest clarification instead of a fabricated proposal. The light-work live intake also ambiguously requested synthetic validation whereas its fixture and authorization were synthetic-only: explicitly state synthetic meeting samples and an exercise catalog. Retain the old ambiguous artifacts; this input clarification is not a claim that the product solved arbitrary real-data scope interpretation.

Current execution checkpoint: Task 1 implementation and independent review are complete. Task 2 is still open on the qualitative issue above (108 recorded requests), not on a request-count limit. Task 3 has fresh local E2E14, unit/integration/CLI1112, restart/backup/restore evidence, but the invitation RSC cancellation recurred and final source packaging has not occurred. Do not tick overall completion until the corresponding gates and evidence are actually satisfied.

2026-09-27 Task 2 further evidenced amendment: final light-work run at 06:06Z mechanically passed but proposed 390 minutes against roughly 360, then 240 unfinished minutes against roughly 180 after reduced availability, while its reply claimed feasibility. Add a model-only deterministic remaining-capacity guard using trusted current time, Shanghai deadline end and latest effective availability (otherwise contract weekly minutes). Exclude retained completed work, do not double-subtract historical actual minutes from a future time horizon, preserve manual review paths and the same shared repair budget. Recheck in the persistence transaction, include safe numeric capacity facts, add an independent lifecycle assertion, and test expiration/calendar/status/withdrawn feedback cases. Do not lower arbitrary estimates or change the formal deadline automatically. This is a correctness guard for the approved adaptive planning workflow, not a new scheduling feature or an authority expansion.

2026-09-27 Task 2 evidenced amendment: the 05:05Z live replan supplied correct base and diff but incorrect executionResets, rejected by unchanged service checks. Move deterministic revision metadata derivation to a strict model-boundary proposal adapter using existing makePlanPayload. Keep caller-supplied base versions, trusted snapshot/fence checks, graph/field validation, public UI/API full revision schema, approval and per-turn limits. This is a repair of model/backend responsibility in the approved workflow, not authorization for automatic approval or a new feature. Update mock fixtures and passive diagnostics to the actual advertised model schema; independently review before another live run.

Tasks 1/2 share the runner API but only Task 1 owns harness construction; Task 2 owns evidenced product fixes. Task 3 consumes frozen product code; independent audit is read-only. All five Review Focus items have explicit owners. Routine technical choices are delegated by the user, so execute this plan without another plan-approval interruption; no new paid/cloud authority is inferred beyond the user's explicit DeepSeek approval.
