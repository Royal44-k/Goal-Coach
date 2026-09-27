# 从本机使用到邀请朋友：完整操作指南（0.2.0）

本页保留 0.2.0 阶段操作背景。新增真实 DeepSeek 接入与 0.2.2 修正版请以[全量验收记录](../delivery/full-acceptance-2026-09-27.md)和[阿里云香港 Docker 新手教程](aliyun-hong-kong-docker-beginner.zh-CN.md)为准；新部署不要混用历史版本包与命令。

本指南更新于 **2026-09-24**。本批次软件实测见[新版验证记录](../delivery/verification-2026-09-24.md)，[旧邀请版记录](../delivery/verification-2026-09-19.md)仅代表历史。源码包含目标管理、受约束的教练流程、DeepSeek/Qwen 适配、邀请账号及 PWA 静态资源。默认 mock 不需要 Key，不产生模型费用，但只走有限预设流程。真实模型、目标 Linux/Docker、域名 HTTPS 和手机真机尚未验收；没有已上线的网址可发给朋友。

下面的使用步骤供实际使用；购买资源、配置域名、启用付费模型均由运营者控制。手机 PWA 只在可连接服务器时访问私人目标、账号和 AI；断网仅显示静态说明页，不离线保存私人内容，也不自动补发写入。

## 1. 先认识产品

一条完整流程是：输入目标 → 澄清完成标准 → 审阅并批准目标契约 → 审阅并批准计划 → 做任务、记录结果和阻碍 → 根据建议调整 → 完成复盘。模型提出建议，数据库中已经批准和保存的状态才是事实。初次计划还没有任务时，没有可以凭空编辑的已有任务；可以保留目标、重试建议或使用当前阶段展示的目标控件。

界面的“撤销”只针对最近一次支持撤销的任务修改或反馈，不是任意历史回滚。反馈撤销保留历史标记，后续分析排除它；删除目标和清空数据各有独立确认。不要用删除数据库修复页面为空，也不要在结果未知时反复提交新的写入。

开发中使用了子 Agent 分工和独立代码审查；应用运行时是一个受状态机、身份、权限和工具约束的模型循环，不是多个大模型互相聊天。模型不能直连数据库、生成批准凭证、执行删除或清空。服务端验证用户归属、当前阶段、参数和批准后才写入。一次输入最多 4 次模型调用、3 次工具调用及 1 次参数修复。

| 想理解什么 | 源码入口 |
| --- | --- |
| 页面与 HTTP 接口 | `src/app`，页面和 `api` |
| 界面组件 | `src/components` |
| 状态与下一步计算 | `src/core/state-machine`、`src/core/planning` |
| 模型及工具循环 | `src/server/agent/orchestrator.ts`、`permission-gate.ts`、`deepseek-client.ts`、`qwen-client.ts` |
| 账号、邀请与会话 | `src/server/auth`、`scripts/auth-admin.ts` |
| 数据归属、版本和事务 | `src/server/repositories`、`src/server/db` |
| 数据库版本升级 | `drizzle` |
| 固定案例评测 | `evals` |
| 服务器部署与维护 | `Dockerfile`、`compose.yaml`、`deploy`、`scripts/database-*.mjs` |

## 2. 在当前 Windows 电脑使用

打开 PowerShell，进入当前源码工作目录。不要同时启动另一份开发或生产服务，也不要结束来源不明的监听器：

```powershell
Set-Location 'C:\Projects\Goal-Coach'
$env:PATH = 'D:\NodeJS;' + $env:PATH
node --version
pnpm --version
$env:pnpm_config_verify_deps_before_run = 'false'
```

版本应为 Node `24.20.0`、pnpm `11.19.0`。最后一行只影响当前终端及其子进程，避免 pnpm 11 在执行脚本前隐式重装已有依赖；它不修改全局配置，也不代替新电脑上的显式安装。当前已有依赖应继续使用。接收源码的新电脑需按[根 README](../../README.md)准备固定版本并执行 `pnpm install --frozen-lockfile`，不要升级运行时、改锁文件或绕过安装保护。

若当前 shell 找不到正确 pnpm，可将下面调用当作 `pnpm` 的备用写法，把后面的 `--version` 换成 `build`、`db:migrate` 等参数：

```powershell
& 'node' 'C:\Users\YOUR_USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.mjs' --version
```

先决定使用哪份库。以前指定的练习库与默认 `data/goal-coach.db` 是不同路径；切换后看见空目标不代表原数据丢失。不要猜测旧库路径。如果继续旧库，使用当时明确记录的绝对路径；新使用者可以明确选择默认路径。下面仅为选择**默认库**的命令，继续旧练习时先把第一行替换为已经核对的旧路径：

```powershell
$env:DATABASE_PATH = Join-Path (Get-Location) 'data\goal-coach.db'
$env:APP_MODE = 'local'
$env:APP_ORIGIN = 'http://127.0.0.1:3000'
$env:MODEL_PROVIDER = 'mock'
$env:DEEPSEEK_API_KEY = ''
$env:DASHSCOPE_API_KEY = ''
$env:DASHSCOPE_BASE_URL = ''
```

你自己的应用可以读取自己的 `.env.local`。已有文件不要覆盖、移走或上传；只在文件不存在时按 README 从 `.env.example` 创建。这里空 Key 用于无费用使用，但 local 模式已保存在设置中的模型选择优先于环境默认值；已有设置曾选真实供应商时，即使尚未同意该供应商的告知，也可在设置页直接切回 mock。邀请模式由服务器配置统一决定，不能在个人页面改提供方。

如果选定库已经存在，先备份再迁移。以下创建当前项目下的备份目录和独立时间戳文件；备份含私人数据，须限制访问并加密离机保存，不要提交或发进聊天：

```powershell
if (Test-Path -LiteralPath $env:DATABASE_PATH) {
  $backupDirectory = Join-Path (Get-Location) 'data\backups'
  New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
  $backupPath = Join-Path $backupDirectory ('before-upgrade-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.db')
  pnpm db:backup -- $backupPath
  if ($LASTEXITCODE -ne 0) { throw '备份失败，停止迁移。' }
}
pnpm db:migrate
if ($LASTEXITCODE -ne 0) { throw '迁移失败，停止启动。' }
pnpm build
if ($LASTEXITCODE -ne 0) { throw '构建失败，停止启动。' }
pnpm local:check
if ($LASTEXITCODE -ne 0) { throw '预检失败，先解决提示的问题。' }
pnpm local:start
```

看到服务就绪后打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。本次验收没有替你重启原来的练习服务；不要以为旧页面已自动变成新版。`local:check` 不安装、不构建、不读取 env 内容、不结束进程；`local:start` 固定回环地址，保持终端打开，按 Ctrl+C 停止它拥有的子进程。页面进入“创建目标”，可用“四周内学会 TypeScript，每天一小时，做一个待办网页”体验已覆盖的 mock 流程。

## 3. 邀请模式意味着什么

local 只适合自己在本机使用；`127.0.0.1` 发给朋友后指向朋友自己的电脑，不能访问你的应用。邀请共享要使用独立服务器、HTTPS 和 `APP_MODE=invite`，不要直接把 3000 暴露公网，也不使用临时隧道替代部署。

注册需要一次性邀请码（72 小时有效）和独立账号。账号名为 3–32 位英文字母、数字、下划线或短横线；密码 12–128 字符，可粘贴和使用密码管理器。管理员界面能邀请、撤销邀请和禁用账号，不能查看别人的目标；但拥有服务器维护权限的运营者可以读取数据库和备份。这不是端到端加密，也不是服务器看不到内容。

每位成员单独保留隐私同意和偏好。运营者启用 DeepSeek 或 Qwen 后，每位用户须确认所选供应商及当前告知版本，必要目标上下文才会发给该供应商。设置页的“撤回模型数据使用同意”只撤回当前账号的模型数据使用同意，不删除目标、不切换提供方、不重置额度；需要模型的新请求将等待再次明确同意，已经发出的请求无法撤回。已批准任务、手动修改和撤销仍可使用；切换供应商后也须重新确认。证据文件仅保存名称、大小和 MIME 类型，不上传原始文件字节。导出只包含该账号业务信息，不包含 Key、账号凭证哈希或会话。

设置页清空在邀请模式只清当前账号业务数据，保留账号、安全记录和日配额；local 清空同时重置本机用量。旧确认短语“清除我的全部本地数据”继续保留，邀请版页面会解释实际是服务器上当前账号的数据。清除不可撤销，两种模式都不改变供应商账单。

手机安装在实际 HTTPS 邀请站点上完成：Android Chrome 可用浏览器的“安装应用”或“添加到主屏幕”；iPhone 须在 Safari 中用“分享 → 添加到主屏幕”。若当前在 Android 或 iOS 的微信等内嵌浏览器且没有可用安装提示，先用系统浏览器打开，必要时复制链接。实际按钮文案因系统和浏览器版本而异。安装图标不代表离线完整应用：断网时只能看到静态提示，目标页面、账号信息、用户输入和私人 API 不缓存；恢复网络后手动刷新状态，不自动补发离线写入或重试付费模型请求。此操作说明尚未经真实手机实测。

## 4. 准备一台目标 Linux 服务器

**以下服务器步骤尚未在本机执行。** 本机没有可用 Docker/WSL，不具备真实云资源或域名；没有容器构建、DNS/TLS、云上恢复的通过声明。目标主机需准备 Docker Engine/Compose、一个自己控制的域名、磁盘和备份空间、维护账号，以及防火墙规则。服务器/域名/存储可能有持续费用，mock 仅免模型费；费用由供应商、地区和用量决定，不把试用额度当长期免费保证。

转移最终审查后的源码包，不上传原始工作目录、`.env.local`、用户数据库、备份、日志、测试结果或依赖。当前源码包生成命令是 `pnpm package:source`，输出新的带版本目录和 SHA-256 manifest，不自动生成 ZIP；正式 0.2.0 包由最终审查完成后的交付步骤生成，不能覆盖旧包。核对清单后在服务器的私有项目目录解包。

域名 A/AAAA 记录指向自己服务器的正确地址；没有可用 IPv6 时不要留下错误 AAAA。对外只开放反向代理需要的 80/443，管理访问按自己的维护方式限制。Caddy 处理 HTTPS，应用 3000 仅在 Compose 内部网络。当前方案必须只有一个 Node 写入进程，不使用多副本、PM2 cluster 或多个服务共享写同一 SQLite；并发限额依赖单进程协调。

## 5. 私下配置、构建和启动

以下在目标 Linux 主机的源码根目录执行；任何一步失败就停止，不继续下一步：

```sh
test ! -e .env && (umask 077; cp deploy/.env.example .env)
```

若 `.env` 已存在，保留它并用私密编辑器核对。将 `APP_ORIGIN` 改成自己域名的唯一 HTTPS origin，如 `https://coach.example.com`（这是示例，不能照当成已上线地址），不加路径、查询或凭据。先保留 `MODEL_PROVIDER=mock` 与空的供应商 Key。Compose 强制邀请模式和 `/app/data/goal-coach.db`，其他值见 `deploy/.env.example`：

| 配置 | 默认值与作用 |
| --- | --- |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | `https://api.deepseek.com` / `deepseek-flash` |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | 当前默认 `4096`，允许 128–8192；旧 2048 显式值仍有效，但长结构化计划可能截断 |
| `QWEN_MODEL` | `qwen3.7-flash-2026-07-15` |
| `QWEN_FALLBACK_MODEL` | `qwen3.7-plus-2026-05-26` |
| `ENABLE_QWEN_FALLBACK` | `false`，默认不降级 |
| `QWEN_MAX_OUTPUT_TOKENS` | `2048`，允许 128–8192 |
| `DAILY_INPUT_TOKEN_LIMIT` / `DAILY_OUTPUT_TOKEN_LIMIT` | 每账号每天 100000 / 30000 |
| `DAILY_AGENT_TURN_LIMIT` | 每账号每天 50，允许 1–1000 |
| `GOAL_COACH_DATA_VOLUME` | `goal-coach-data-v020`，持久化数据库卷 |
| `GOAL_COACH_IMAGE` | `goal-coach-agent:0.2.0`，审核后记录实际镜像 digest |

```sh
docker compose config --quiet
docker compose build app
docker compose run --rm --no-deps app pnpm deployment:check
docker compose run --rm --no-deps app pnpm db:migrate
docker compose run --rm --no-deps app sh -c 'test "$(id -u)" = 1000 && test -w /app/data'
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d --build
docker compose ps
docker compose exec app node -e 'fetch("http://127.0.0.1:3000/api/health").then(async r=>{if(r.status!==200 || !(await r.json()).ok) process.exit(1); console.log("内部健康检查通过")}).catch(()=>process.exit(1))'
```

用 `config --quiet` 避免展开 Key；不要把完整 config、环境转储或 docker inspect 贴出来。`deployment:check` 不打开数据库、不联网；内部 health 只检查配置和只读数据库连通性，无模型调用，不能证明完整业务或真实模型可用。公网 `/api/health` 被 Caddy 返回 404 是有意行为。

Docker 镜像固定 Node 24.20.0、pnpm 11.19.0，代理固定 Caddy 2.11.4；目标主机需确认标签可拉取并记录 digest。better-sqlite3 的 Linux 原生构建、UID 1000 的卷写权限、重启后数据持久化、HTTPS 与只读挂载恢复尚须目标环境验收，详见[部署细节](README.md)及[只读挂载演练](operations.md#目标-linux-主机的只读挂载验收)。不要把应用改成 root 来掩盖权限问题。

## 6. 建立管理员并邀请朋友

在私密终端执行，关闭录屏和屏幕共享：

```sh
docker compose exec app pnpm auth:admin bootstrap
```

仅本次输出管理员邀请码和过期时间。打开自己的 HTTPS 地址 `/login`，选择“使用邀请注册”，填写账号、密码和邀请码。不要把邀请码放 URL、截图、聊天记录或日志。已有管理员或有效管理员邀请时 bootstrap 拒绝重复生成；没有管理员且邀请过期后可再生成。

管理员登录后进入“邀请与账号”，点“创建普通邀请”，私下交给朋友。朋友在单独浏览器或独立浏览器账号中注册，看到自己的目标。未使用邀请可撤销；禁用账号会立即撤销其会话，最后一个启用的管理员不能禁用。管理员忘记密码不能靠重新 bootstrap 绕过；运维者用[标准 stdin 重置步骤](operations.md#管理员恢复禁用和撤销)，新密码不得写进命令参数或历史。

## 7. 日常备份、恢复和更新

先定期备份到新文件，记录时间、应用版本、schema 和哈希，加密离机保留。`db:backup` 使用 SQLite backup API 包含已提交 WAL，再把临时快照转成自包含的 DELETE 日志模式；源数据库继续原模式。不要在写入时普通复制主 db，也不要把会话/密码摘要所在的备份当成可公开文件。脚本拒绝覆盖已存在目标，文件系统需支持硬链接。

实际容器备份、恢复到新卷、账号恢复和回滚命令以[运维手册](operations.md)为准。恢复前停止 app 和 Caddy，保留旧卷，使用从未用过的新路径/新卷；禁止 `docker compose down -v`。脚本不能替你证明其他写进程已停止。恢复会回到备份时的账号、会话和配额状态，需要时重置密码、撤销旧邀请。

更新前备份并保留旧镜像及对应私密配置。先在独立卷试迁移，再对正式库操作。旧程序可能不识别已持久化的 `provider=deepseek`，即使数据库迁移只新增字段，也不能承诺仅换回旧镜像即可回滚。须用匹配旧版的升级前备份恢复到全新卷并演练；备份后的变化需另行核对/处理，不能假装自动保留。禁止 `docker compose down -v`，保留原卷。0.1.0 没有认证，不能当公网邀请版的回滚版本。

## 8. 以后再启用真实 DeepSeek

本轮没有配置真实 Key、没有联网调用、没有质量评分。mock 状态显示预设流程；完整 DeepSeek 配置只表示“已填写、尚未验证”，部署检查和 health 均不向供应商发送请求。

将来先在自己的 DeepSeek 账号确认模型权限、余额、价格和预算，私下把 Key 填入服务器 `.env` 的 `DEEPSEEK_API_KEY`，设 `MODEL_PROVIDER=deepseek`。代码限定官方地址 `https://api.deepseek.com` 与 `deepseek-flash`/`deepseek-v4-pro` 两个模型标识；实际可用性与模型快照仍须当时核验。依据[官方 API 入口](https://api-docs.deepseek.com/)及[实时价格](https://api-docs.deepseek.com/quick_start/pricing/)；不要把 Key 发给 Codex 或放入 `NEXT_PUBLIC_`。

当前 DeepSeek 适配使用非流式 Chat Completions 普通文本与 Function Calling，显式关闭思考模式，带输出上限；没有把所有对话强制成 JSON。服务端校验工具参数。配置检查不发请求，不能证明权限、余额、网络或工具质量。[官方 Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)及[思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)是协议参考，未来开启思考模式需另行适配。

运营者私下设置 DeepSeek 后，先 `docker compose config --quiet`、`docker compose run --rm --no-deps app pnpm deployment:check`，再 `docker compose up -d --no-deps --force-recreate app`。邀请用户不能自行换模型或提高额度；每人仍须对 DeepSeek 和当前版本的告知单独同意。默认每账号同时 1 回合、全局 2 回合，按上海自然日计算日限额。本机 local 模式已有持久化模型选择时，须在设置页手动切换并重新同意。

真实评测仅在另行明确同意调用范围和费用后进行。私密本地源码中显式运行 `pnpm eval:deepseek --allow-live`，脚本选定前 5 例（仅 L01–L05），每例最多 4 次供应商调用；直接 CLI 必须显式给 `--provider=deepseek --max-cases=1..5 --allow-live`。无 opt-in 时在读取 `.env.local` 前拒绝。`eval:live` 仍指 Qwen，需同样的 opt-in。镜像未包含 evals。调用次数和 token 配额不是账单硬上限：超时未知用量、崩溃或一条回答跨过限额仍须在供应商侧监控。本轮只执行免费 30 例 mock 评测。

如以后继续使用 Qwen，沿用独立的 `DASHSCOPE_API_KEY` 与工作区 HTTPS `DASHSCOPE_BASE_URL`，设置 `MODEL_PROVIDER=qwen`；换供应商后每个用户须重新同意。Qwen 旧阶段的[官方文档核查](../research/2026-09-18-qwen-readiness.md)是历史资料，不证明当前账号可用。DeepSeek Key 不能代替 Qwen 凭据。

## 9. 自动验收与常见问题

生产使用目录可能有私密配置。**不要在那里直接运行浏览器验收**：E2E 启动前会拒绝含非示例 `.env*` 的根目录。测试使用不含私密配置、用户库的源码副本和自动生成的临时数据库，不能连接现有 3000 练习服务。新副本安装锁定依赖或由维护者链接已验证依赖；不要重装或删除链接指向的依赖。链接依赖在目录外时，测试副本按已安装 Next 文档将 Turbopack root 设为共同父目录，生产配置不因此更改。

在准备好的干净副本根目录，可运行以下命令（第一组单元检查也可在原目录用明确合成环境运行，不启动 Next 或加载 env 文件）：

```powershell
$env:pnpm_config_verify_deps_before_run = 'false'
$env:APP_MODE = 'local'
$env:MODEL_PROVIDER = 'mock'
$env:DEEPSEEK_API_KEY = ''
$env:DASHSCOPE_API_KEY = ''
$env:DASHSCOPE_BASE_URL = ''
$env:DATABASE_PATH = ':memory:'
pnpm lint
pnpm typecheck
pnpm test
$env:E2E_PORT = '3324'
$env:APP_ORIGIN = 'http://127.0.0.1:3324'
node node_modules/@playwright/test/cli.js test --config=playwright.config.ts
$env:E2E_PORT = '3325'
$env:APP_ORIGIN = 'http://127.0.0.1:3325'
node node_modules/@playwright/test/cli.js test --config=playwright.invite.config.ts
$env:NODE_OPTIONS = '--require=./e2e/block-external-network.cjs'
pnpm eval
Remove-Item Env:NODE_OPTIONS
```

每条命令非零时停止并读取错误。两套浏览器各自生产构建、迁移临时库、验证指定端口空闲，并只停止自建进程；占用时拒绝复用。Node 测试预加载器阻止非回环 TCP，邀请浏览器另阻止非本服务请求；不把这当生产防火墙。单元测试/评测验证固定行为，Edge 浏览器验证实际操作与375px布局，构建验证可编译，均不能替代真机、云主机与真实 DeepSeek 验收。

| 遇到什么 | 接下来做什么 |
| --- | --- |
| 页面是空库 | 核对本次 `DATABASE_PATH`，保留原库，不删除任何数据库 |
| 端口占用 | 确认自己的服务；不要结束未知进程或复用其数据库 |
| 邀请失效 | 核对是否已用/撤销/过期，联系管理员生成新普通邀请 |
| 账号退出或禁用 | 回到登录；由管理员处理，不重放失效 cookie |
| 配置未就绪 | 保持 mock，运营者核对私密配置；配置检查不是联网验证 |
| 模型超时/未知写入结果 | 先重读正式状态或用同一请求查询，避免重复产生新操作 |
| 数据库或卷权限错误 | 停止写入、保留库和备份；按运维步骤核对准确路径/权限 |

本批次本地通过项、失败后修正和确切证据见[新版验证记录](../delivery/verification-2026-09-24.md)。尚未执行项明确保留：真实模型、真实 DNS/TLS、公有云部署与云上恢复、Linux 容器构建（本机无 Docker）、iOS/Android 真机，以及全新 Windows 电脑安装验证。中国大陆公开试用前还须核对主体、接入商与适用备案/登记及 AI 内容标识路径；参见[基线核查与官方资料](../research/2026-09-24-goal-coach-review-and-roadmap.zh-CN.md#部署地区与合规前置检查)。
