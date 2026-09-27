> 历史设计/执行记录，保留当时决策；路径已匿名化。当前行为、默认值和发布权限以仓库当前规格及本次发布说明为准。

# DeepSeek 与 PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为Goal Coach接入受控DeepSeek，交付可安装的PWA及大陆邀请试用的软件准备，不虚构真实调用或公网验收。

**Architecture:** 保留现有Next/React/SQLite单实例与受限工具Agent。独立供应商适配和统一模型策略、版本化同意、最小PWA层分别测试；部署与交付验证汇总跨层结果。

**Tech Stack:** Node.js 24.20.x、pnpm 11.19.x、Next.js 16.3.4、React 19.2.8、TypeScript、OpenAI SDK 7.10.0、Zod、Drizzle、better-sqlite3、Vitest、Playwright。

**Spec:** docs/superpowers/specs/2026-09-24-deepseek-pwa-design.md。

## Global Constraints

- Node.js 24.20.x、pnpm 11.19.x，沿用当前锁定依赖，不升级框架、不重装现有node_modules。
- 不读取或输出 .env.local、API Key、真实用户数据库内容；测试使用合成配置和独立临时数据库。
- 默认 MODEL_PROVIDER=mock；不进行真实模型网络请求，不购买云资源、不提交备案、不公开发布、不推送或合并分支。
- 不出现“本机 · 私密 · 可撤销”等展示样机式标语；必要的模型状态、隐私、AI告知与错误提示保留。
- 生产方案限定邀请模式、HTTPS、单个Next.js进程与持久化SQLite卷；现有身份隔离、Origin校验、统一撤销和审批边界不得放松。
- PWA不得缓存私人API、目标页面、账号信息或用户输入；不得自动补发离线写请求或自动重试付费模型请求。
- 所有通过结论须附对应环境的实测证据；桌面窄屏不等于真机，配置有效不等于真实模型可用，Next构建不等于Docker构建。

## Review Focus

1. 保存provider与环境默认不同：必须使用选中供应商独立凭据，不能把DeepSeek Key送给Qwen；Task 2服务集成测试固定此行为。
2. 已展示旧同意页面后服务器换供应商：提交必须被拒绝，派发前再次校验；Task 2版本与撤回测试。
3. 供应商返回半截但语法完整的工具参数：不能执行，已知用量仍可记账；Task 1 finish_reason/usage测试。
4. 手机切后台、断网、更新与切换账号：不得重放写请求或缓存上一账号内容；Task 3 SW行为与安装态测试。
5. “部署检查通过”被误当“真实模型通过”：默认mock、无隐式网络、评测opt-in、不同环境验收分别标注；Task 4测试和交付报告。

## 执行约定与基线

用户已委托常规决策，不再次请求规格/计划或任务间确认。执行方先自审此计划，再沿用此前子Agent驱动；每个任务一个实现者和一个任务审查，最后综合审查。共享文件的任务顺序执行。代码工作区为C:/Projects/Goal-Coach，已处于feat/local-goal-coach-mvp隔离工作树。

已安装工具：node；pnpm CLI位于C:/Users/YOUR_USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs；Git位于D:/ProgramData/Git/cmd/git.exe。测试可直接使用node node_modules/vitest/vitest.mjs，避免pnpm启动时自行安装依赖；pnpm调用设置pnpm_config_verify_deps_before_run=false与pnpm_config_update_notifier=false。配置项使用进程级变量，不改机器配置。

基线2026-09-24：完整单测927通过、9项脚本测试因沙箱uv_os_get_passwd/ENOMEM失败；相同两文件在许可的沙箱外环境9/9通过。无产品修改。该环境差异不得通过改业务代码或忽略测试消除。

每任务：先失败测试→最小实现→针对性验证→全套回归一次→自审→只提交本任务文件。若测试遇到同一沙箱限制按工具权限流程运行必要范围，不读取私人环境文件。review-package与task-brief由SDD脚本生成到本计划scratch。

---

### Task 1: DeepSeek配置、协议适配与安全错误

**Files:**
- Create: src/server/config/deepseek-config.ts, src/server/config/deepseek-config.test.ts
- Create: src/server/agent/deepseek-client.ts, src/server/agent/deepseek-client.test.ts
- Create: src/server/agent/openai-chat-protocol.ts (只抽取两适配器共用的可见消息转换/响应投影)
- Modify: src/server/agent/qwen-client.ts, src/core/errors/app-error.ts, src/server/agent/agent-turn-error.ts
- Test: src/server/agent/qwen-client.test.ts, src/server/agent/agent-turn-error.test.ts及新增配置/协议测试。

**Interfaces:**
- Consumes: ModelClient.complete(ModelRequest): Promise<ModelTurn>、ModelRequestSchema、ModelResponseError、现有QwenTransport/factory约定。
- Produces: DeepSeekConfig = {apiKey?: string; baseURL: string; model: 'deepseek-flash'|'deepseek-v4-pro'; maxOutputTokens: number}；loadDeepSeekConfig(input: Record<string,string|undefined>): DeepSeekConfig；requireDeepSeekConfig(config: DeepSeekConfig): DeepSeekConfig & {apiKey:string}。
- Produces: new DeepSeekClient(config: DeepSeekConfig, factory?: DeepSeekClientFactory): ModelClient；factory可注入假传输，默认使用OpenAI SDK。Task 2负责注册到实际服务，此任务不修改主环境/界面/provider枚举。
- Produces: MODEL_BALANCE_INSUFFICIENT安全错误及可持久化AgentTurnFailure支持；共享协议私有细节不得改变ModelTurn字段。

- [ ] **Step 1: 编写并运行失败配置/传输测试。**

```ts
const config = loadDeepSeekConfig({ DEEPSEEK_API_KEY: 'synthetic-secret' });
expect(config).toEqual({ apiKey: 'synthetic-secret', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', maxOutputTokens: 2048 });
expect(() => requireDeepSeekConfig(loadDeepSeekConfig({}))).toThrowError(expect.objectContaining({ code: 'MODEL_CONFIG_MISSING' }));
expect(() => loadDeepSeekConfig({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com.attacker.invalid' })).toThrow();
```

覆盖根路径、/v1、尾斜线规范化，非法HTTP/query/hash/userinfo/其他主机，模型白名单、128/8192边界、空Key、NEXT_PUBLIC同值及脱敏。假传输捕获请求而非联网，输入来自modelToolDefinitions()及合法工具往返；断言thinking.disabled/max_tokens/stream:false，不含Qwen字段和无工具时的tools。

Run: `node node_modules/vitest/vitest.mjs run src/server/config/deepseek-config.test.ts src/server/agent/deepseek-client.test.ts`
Expected RED: 新模块/导出缺失。记录实际失败，不能跳过。

- [ ] **Step 2: 实现配置和供应商客户端。**

```ts
const requestBody = { model: request.model, messages,
  stream: false as const, thinking: { type: 'disabled' as const }, max_tokens: config.maxOutputTokens,
  ...(request.tools.length ? { tools, tool_choice: 'auto' as const } : {}) };
const transportOptions = { apiKey: config.apiKey, baseURL: config.baseURL, timeout: 45_000, maxRetries: 0 };
```

实际代码先ModelRequestSchema.parse；只允许配置模型；共享转换代码抽取而非复制Qwen大段实现。响应投影忽略reasoning_content，只接受DeepSeek终止为stop且无toolCalls，或tool_calls且有toolCalls；其余抛ModelResponseError(已知usage或null)。DeepSeek配置仅服务端导入，浏览器环境拒绝。

- [ ] **Step 3: 先失败再实现错误与终止状态测试。**

使用OpenAI APIError/connection错误假对象，断言401/403→MODEL_AUTH_FAILED、402→MODEL_BALANCE_INSUFFICIENT、400/404/422/5xx/连接→MODEL_UNAVAILABLE、429→MODEL_RATE_LIMITED、timeout→MODEL_TIMEOUT，错误字符串与safe response不含synthetic-secret/provider body。用finish_reason=length且工具JSON完整的响应验证拒绝执行并保留usage；覆盖stop+tools、tool_calls+空tools、负数usage、重复ID、畸形包与隐藏推理。把新增及现有供应商错误加入AgentTurnFailureSchema并验证序列化保留原错误而非DATABASE_ERROR。

- [ ] **Step 4: 验证与自审。**

Run: `node node_modules/vitest/vitest.mjs run src/server/config/deepseek-config.test.ts src/server/agent/deepseek-client.test.ts src/server/agent/qwen-client.test.ts src/server/agent/agent-turn-error.test.ts`，然后typecheck、完整vitest。Expected GREEN，无真实HTTP。

- [ ] **Step 5: 提交任务文件并记录报告。**

`git add`仅列本任务源码/测试；`git commit -m "feat: add guarded DeepSeek model adapter"`。报告含RED/GREEN命令、实际结果、风险；不要提交env.local、数据库、研究草稿或另一任务文件。

### Task 2: 全链路模型策略与版本化同意

**Files:**
- Create: src/lib/model-policy.ts, src/server/config/effective-model-policy.ts及测试
- Modify: src/server/config/env.ts及测试；src/core/domain/contracts.ts；src/lib/public-api-schemas.ts
- Modify: src/server/db/schema.ts, src/server/db/migrate.ts及新drizzle迁移/元数据；src/server/repositories/repository-inputs.ts与必要映射/测试
- Modify: src/server/services/settings-service.ts, service-container.ts；src/server/agent/orchestrator.ts, agent-turn-store.ts, model-readiness.ts
- Modify: src/components/privacy/privacy-gate.tsx, src/components/settings/model-settings.tsx, model-readiness.tsx及调用方/对应测试
- Test: src/server/services/services.test.ts、src/server/agent/orchestrator.test.ts、agent-turn-store.test.ts、model-readiness.test.ts；新增src/server/services/provider-policy.test.ts。

**Interfaces:**
- Consumes: Task 1的DeepSeekConfig/loadDeepSeekConfig/DeepSeekClient。
- Produces: ModelProvider含deepseek；EffectiveModelPolicy = {provider: ModelProvider; primaryModel: string; fallbackModel: string|null; fallbackEnabled: boolean}，resolveEffectiveModelPolicy(env: ServerEnv, provider: ModelProvider): EffectiveModelPolicy，不含秘密。
- Produces: ServerEnv保留原Qwen字段兼容，新增deepseek: DeepSeekConfig；Qwen使用原apiKey/baseURL，DeepSeek只使用deepseek，不能把选中供应商Key覆盖到共享字段。
- Produces: MODEL_PRIVACY_POLICY_VERSION='2026-09-24'；每账号新增privacyProvider、privacyPolicyVersion可空列；公开设置给同意状态/版本、当前有效模型；SettingsUpdate接收privacyProvider/privacyPolicyVersion，privacyAccepted=true必须匹配当前真实供应商及告知版本。
- Produces: AgentOrchestrator与AgentTurnStore接受有效模型策略/运行模型的可选依赖（缺省保持原Qwen/mock单测兼容）；运行记录、主循环、摘要及超时均用同一策略。

- [ ] **Step 1: 固定安全行为的失败测试。**

在服务测试现有独立db fixture上增加两个合成用户、fake client decorator：

```ts
const policy = resolveEffectiveModelPolicy(loadServerEnv({ MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'synthetic' }), 'deepseek');
expect(policy).toEqual({ provider: 'deepseek', primaryModel: 'deepseek-flash', fallbackModel: null, fallbackEnabled: false });
expect(policy).not.toHaveProperty('apiKey');
```

固定Qwen同意不能授权DeepSeek、旧timestamp无版本不够、旧页面提交provider拒绝、新同意成功、撤回后下一dispatch拒绝、邀请用户不能修改provider/额度、mock无需Key。saved provider不同于env默认分别用各自凭据，Qwen历史model不改写。记录RED。

- [ ] **Step 2: 加法迁移与设置实现。**

```sql
ALTER TABLE app_settings ADD COLUMN privacy_provider text;
ALTER TABLE app_settings ADD COLUMN privacy_policy_version text;
```

按仓库现有迁移编号、元数据与schema一致性习惯新增迁移，不改旧迁移、不读真实库。原时间保留但新gate判无效；新/旧库重复执行迁移安全。get/update按现有乐观锁与事务，读取邀请政策不得悄悄把旧同意当新同意。若local切供应商则模型同步当前策略，不能遗留Qwen模型。UI看到什么供应商就只能同意什么供应商。

- [ ] **Step 3: 连通所有派发与审计。**

```ts
const policy = resolveEffectiveModelPolicy(env, setting.provider);
const client = setting.provider === 'deepseek' ? new DeepSeekClient(env.deepseek)
  : setting.provider === 'qwen' ? new QwenClient(env) : mockClient;
```

客户端保持惰性创建以免幂等重放构造真实client。每次complete检查同意版本和provider仍匹配；DeepSeek超时允许既有安全预算内同模型重试但不跨供应商，已有副作用后不自动重试。通过同一policy为摘要、首轮、重试和run提供model；测试捕获所有request.model并检查持久AgentRun。受控同意失败在admission之前，不能消耗每日新回合。

- [ ] **Step 4: 更新设置与隐私界面并回归。**

选择DeepSeek展示对应告知；取消仍不派发；邀请只读；readiness不联网。更新相关类型fixture和APIschema，所有响应不含secret。分别显示配置状态，liveVerified始终false直到另行受控验收，不制造绿色联网状态。保留Qwen和mock说明。

Run: 针对上述文件的Vitest，然后lint/typecheck/全套Vitest。对原API与界面调用点使用`rg`定位，相关旧测试应调整为版本化同意而非放宽验证。

- [ ] **Step 5: 自审并提交。**

检查DB/领域/公开schema一致、默认配置不变、预算和撤销回归；`git commit -m "feat: integrate provider-aware model policy and consent"`，只提交任务文件。

### Task 3: 安全可安装PWA

**Files:**
- Create: src/app/manifest.ts, public/sw.js, public/offline.html；public/icons下192/512 PNG与可重生成源/脚本
- Create: src/components/pwa/pwa-controls.tsx, src/components/pwa/pwa-controls.test.tsx, src/lib/pwa.test.ts
- Modify: src/app/layout.tsx, src/components/layout/app-shell.tsx, src/app/globals.css, next.config.ts；必要安装入口测试
- Test: 新增e2e-invite/pwa.spec.ts与独立生产构建测试启动配置（不可修改用户3000服务）。

**Interfaces:**
- Consumes: 现有app shell、邀请登录与服务端策略；不改模型API/数据格式。
- Produces: manifest路由、PWAControls客户端组件、GET /sw.js与纯静态离线页；这些public资源也满足Docker现有COPY源。

- [ ] **Step 1: 先写manifest与SW行为失败测试。**

```ts
expect(manifest()).toMatchObject({ name: 'Goal Coach', start_url: '/', scope: '/', id: '/', display: 'standalone', lang: 'zh-CN' });
expect(manifest().icons?.map(icon => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
```

用node:vm执行实际SW脚本并派发假的fetch event，验证POST /api/agent、GET /api/settings、跨域请求没有respondWith与缓存写；导航成功不缓存，失败只返回离线说明；缓存仅有无身份静态页。测试旧缓存只清理本app命名空间，不删除别的应用缓存。

- [ ] **Step 2: 实现安装资源和安装入口。**

读本地Next manifest/metadata/PWA文档再修改。图标复用现有标识，用本地脚本可重复生成PNG，尺寸/文件签名测试；不调用外部图标服务。安装入口根据beforeinstallprompt事件启用，iOS显示系统浏览器主屏步骤；独立显示态隐藏；无支持时提供操作说明，不显示无效按钮。

- [ ] **Step 3: 实现断网/更新的最小SW。**

```js
if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin
    || event.request.mode !== 'navigate') return;
event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
```

以上分支需排除/api路径并处理离线页缺失的安全静态响应。只缓存/offline.html；无用户输入、目标、账号、JS chunks、API缓存。生产环境才注册，SW设置no-store/updateViaCache:none。waiting worker不自动skipWaiting；只接受用户明确更新消息，刷新须用户触发且提示未保存输入风险；没有自动重试付费或写操作。

- [ ] **Step 4: UI和浏览器验证。**

组件测试：支持/不支持、standalone、iOS安装说明、监听器清理、离线提示、等待更新不自动reload。Edge独立生产预览验证manifest/icons/SW注册，离线导航、两账号退出后无私人cache、375px无横向溢出。不得把UA模拟写成iPhone真机通过。当前开发3000与私人库不得接触。

- [ ] **Step 5: 回归、自审、提交。**

Run: PWA/布局测试、lint/typecheck、全套Vitest；新增静态public确保Docker COPY源被Git跟踪。`git commit -m "feat: add privacy-safe installable PWA"`。

### Task 4: DeepSeek部署与评测入口、交付证据

**Files:**
- Modify: .env.example, deploy/.env.example, compose.yaml, scripts/deployment-check.mjs及测试, src/app/api/health/route.ts及测试
- Modify: evals/run.ts, evals/schema.ts, evals/evals.test.ts, package.json（仅脚本，无依赖改动）
- Modify: scripts/package-source.mjs及测试, README.md, docs/deployment/full-guide.zh-CN.md, docs/deployment/operations.md
- Create: docs/delivery/verification-2026-09-24.md

**Interfaces:**
- Consumes: Task 1配置、Task 2provider政策/同意、Task 3静态资源。
- Produces: MODEL_PROVIDER=deepseek可配置的Compose；部署/health离线校验；显式受控DeepSeek评测入口；与现有真实脚本匹配的大陆PWA指南与验证证据。

- [ ] **Step 1: 写失败部署与打包测试。**

```js
const configured = { MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'synthetic', DEEPSEEK_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'deepseek-flash' };
// 使用现有check helper，运行配置校验子进程，不发送HTTP。
assert.equal(check(configured).status, 0);
assert.equal(check({ ...configured, DEEPSEEK_API_KEY: '' }).status, 1);
```

补错误不含Key、Qwen与DeepSeek凭据不互替、Compose传递全部变量、无Key默认mock、source包包含SW/manifest/icons且拒绝秘密/数据库；健康检查仅本地配置与db。

- [ ] **Step 2: 更新部署与评测安全入口。**

env示例DeepSeek Key为空、默认mock；固定官方地址，说明需私下填写。保留Qwen变量但不默认调用。eval --provider=deepseek支持结果schema；非mock须--allow-live且--max-cases范围1–5，无opt-in在任何client/数据库业务创建之前拒绝。新增`eval:deepseek`仅显式用户执行，不能被verify/default eval间接触发。测试用假工厂/合成配置检查无授权零请求；本任务禁止实际运行live命令。

- [ ] **Step 3: 全套软件验证与隔离构建。**

运行lint、typecheck、全套Vitest、30例mock评测及本机/邀请浏览器故事。生产build使用白名单源码副本（不含.env.local/data）和独立临时数据库，不能在用户正在使用的.next目录构建。依赖使用现有安装，不网络升级。若Docker/真机/域名不可用，记录未验证及命令，不下载或购买代替。

- [ ] **Step 4: 更新大陆邀请试用指南和交付报告。**

按实际代码写私下Key配置、mock→DeepSeek切换、版本化同意、手机安装/联网边界、管理员/邀请、费用和备份恢复、回滚。引用核查报告已核实的MIIT/CAC/DeepSeek官方材料，主体/备案号没有则明确准入待满足，不写虚假法律结论。报告列每条命令、日期、结果、未验证项，保留费用监控/进程崩溃恢复/真机/生产准入缺口。

- [ ] **Step 5: 提交、独立综合审查。**

`git commit -m "docs: prepare DeepSeek PWA invitation delivery"`。最终审查从3edbb1e基线到本批次HEAD；实际源码包如生成应含当前提交并剔除秘密，不覆盖历史包。只有所有门禁通过才标记软件增量完成；未授权的真实模型/公网部署保持未完成，不泛称整个商业产品落地。

## 计划自审

2026-09-24：四任务分别覆盖协议、安全策略、移动层、交付。依赖按1→2→3→4顺序，共享env/UI/部署接口集中于各自任务。重点五种风险均有对应失败测试。真实模型/主机/设备是外部验收门槛，软件任务不会伪造通过；无需向用户继续询问常规技术选项。
