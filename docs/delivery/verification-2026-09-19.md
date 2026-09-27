# 邀请版阶段验证记录

阶段标识/文件名：2026-09-19。**实际执行日期：2026-09-20（Asia/Shanghai）**。本记录证明本机源码和合成数据验收，不代表公网已上线或 Qwen 已通过真实调用。初学者操作见[完整指南](../deployment/full-guide.zh-CN.md)。正式 0.2.0 源码包须在最终独立审查后生成，本记录没有提前创建该不可覆盖的输出目录。

## 执行环境和隔离

- Windows，Node 24.20.0、pnpm 11.19.0、Next 16.3.4、已安装 Edge。没有升级运行时/依赖，也没有下载或安装 Docker、WSL、浏览器。
- 原始源码目录：`C:/Projects/Goal-Coach`。原 `.env.local` 存在但本轮未读取、改名、移走或删除；未读取用户原数据库，未复用 3000 练习服务。
- 最终构建/浏览器副本：`C:/Projects/goal-coach-task4-check-1c049e19-d385-4bff-b4dd-932f995a7d83`（匿名化历史路径，副本不随仓库交付）。从明确源码白名单复制 272 个文件，排除私密 env、数据库、日志和用户数据；依赖仅链接已有 node_modules。副本的 Turbopack root 设为副本与依赖的共同父目录 `C:/Projects`，生产配置未改变。
- 本机 E2E 使用 `E2E_PORT=3324`、`APP_ORIGIN=http://127.0.0.1:3324`；邀请 E2E 使用 3325 及其对应 origin。两者分别创建 GUID 临时数据库，先迁移、生产构建再启动，拒绝任何预先存在的监听器，只停止自己创建的子进程。结束时四地址绑定检查通过。
- Next build/start 子进程强制 mock 和空 Key/Base URL，Node 测试预加载器阻止非回环 TCP；全单元和 mock 评测也加载该阻断器。实际验证了 net、fetch、HTTPS 外部请求在连接前失败，以及回环连接可用。邀请浏览器另外拒绝非本服务请求。此测试防护不是生产系统防火墙，浏览器拦截也不被当作服务端断网的唯一证据。

## 本轮结果

| 项目 | 实际结果 | 退出码 |
| --- | --- | --- |
| `pnpm lint` | 无错误/警告 | 0 |
| `pnpm typecheck` | 通过 | 0 |
| `pnpm test` | 80 文件，936 测试通过，47.28 秒 | 0 |
| 显式 `pnpm build` | Next 16.3.4，编译 788ms，类型检查 2.5s，11/11 静态页面；另两套浏览器各自构建通过 | 0 |
| 邀请 Edge E2E | 1 个完整跨账号故事通过，9.4 秒，含构建/清理约 1.2 分钟 | 0 |
| 原有本机 Edge E2E | 13/13 通过，约 1.8 分钟；包括实际等待 45 秒的 HTTP 超时夹具 | 0 |
| mock 评测 | 30/30，crash=0，未批准结构写入=0，machineFailure=0 | 0 |
| 网络防护自检 | 外部 net/fetch/HTTPS 拒绝，loopback 正常 | 0 |
| 清理证明 | 3324/3325 在 IPv4/IPv6 四绑定地址均可重新独占绑定 | 0 |

Playwright 启动时有环境层 `NO_COLOR` 与 `FORCE_COLOR` 冲突提示；它不是网页控制台错误。邀请测试在首次导航前注册 pageerror、console error、requestfailed 和 HTTP>=400 监听；最终意外错误数组为空。故意验证的 404/403/401 使用独立 API 请求并分别断言，不从意外错误中笼统忽略。

邀请故事执行了：合成管理员邀请 → 浏览器注册管理员 → 管理页创建普通邀请 → 独立浏览器上下文注册成员 → 成员创建目标并批准契约/计划 → 管理员列表为空且读成员目标 404 → 成员账号管理 403 → 空模型配置检查 → 退出后 API 401 → 手动放回退出前 cookie 仍为 401。管理员会话仍可用。

readiness 的真实契约是 `provider:mock, configured:false, liveVerified:false, status:mock_selected`。页面明确显示“当前未连接模型，对话使用预设流程”和“未验证 Qwen 供应商连接”。`configuration_missing` 是选择 Qwen 后缺配置的状态，已有单元测试覆盖；没有为了验收把 mock 的状态改写成它，也没有声称 UI 展示了凭据值。

全套单元覆盖身份/邀请拒绝、跨账号 API、Origin、审批、每日/并发限额、导出/清空隔离、真实 SQLite 备份与恢复等。936 通过包含 Task4 新增的自包含快照和 Windows NTFS ACL 真正拒绝源目录写入的恢复测试；这仍不等于 Linux `:ro` 挂载验收。详细目标矩阵不意味着所有边界都在一个浏览器故事中重复执行。

## 发现、修复与失败记录

1. 初次 `pnpm exec playwright` 在该 Windows 安装中找不到命令入口，改为已安装 `@playwright/test/cli.js` 的直接 Node 调用，没有重装依赖。
2. 新测试 preload 的 Windows 路径在 NODE_OPTIONS 中丢失反斜杠，构建退出 1；改用正斜杠路径后构建通过。
3. 首次邀请浏览器在两个 `role=status` 元素间发生测试定位歧义；改为配置检查区域内的定位器。该轮停止自有 PID 9736 被 Windows 拒绝，临时合成库保留。随后该 PID 已不存在，3325 四地址可绑；没有按端口批量结束进程。后续使用正常 Windows 权限执行自有进程生命周期并取得完整退出码 0。
4. 浏览器实际发现登录表单 `pattern="[A-Za-z0-9_-]+"` 在 HTML Unicode v 模式是非法表达式，两次注册各产生一条 console error。经主任务批准，只修复 JSX HTML pattern 的连字符转义，服务端用户名规则不变。
5. 进一步 RED：实际浏览器对 `invalid.name` 的 `checkValidity()` 返回 true，测试期待 false，退出 1。GREEN：合法 `Abc_123-test` 通过，含点和中文账号均无效，完整邀请故事零意外 console/page/network 错误，退出 0。
6. 一次中间 setup 以 AggregateError 非零退出，旧错误输出没有展开内部原因；没有将其算作验收通过。随后增强测试错误的内部原因输出，检查无匹配的残留 acceptance Node 命令行，最终两套完整 E2E/绑定清理均通过。该次中间原因未被追溯确认。
7. 初次 lint 报测试 CommonJS preload 的 require-import 规则；仅为 Node CommonJS preload 那一行添加有理由的例外，最终全 lint 无错误/警告。

## 可复现命令

本机 Node 为 `node`；pnpm CLI 为 `C:/Users/YOUR_USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs`。下文 `pnpm` 代表用该 Node 调用该 CLI。均设置当前命令进程 `PATH=D:/NodeJS;...`、`pnpm_config_verify_deps_before_run=false`，不修改全局配置。全单元在原源码目录运行，使用 `APP_MODE=local`、`MODEL_PROVIDER=mock`、空 `DASHSCOPE_API_KEY`/`DASHSCOPE_BASE_URL`、`DATABASE_PATH=:memory:`，并为 `pnpm test` 设置绝对路径 Node preload。

```powershell
pnpm lint
pnpm typecheck
$env:NODE_OPTIONS = '--require=C:/Projects/Goal-Coach/e2e/block-external-network.cjs'
pnpm test
```

**以下仅在上述干净源码副本中执行，不能在原私密配置目录执行。** 浏览器 setup 还会拒绝根目录中任何非示例 `.env*` 文件：

```powershell
$env:E2E_PORT = '3325'
$env:APP_ORIGIN = 'http://127.0.0.1:3325'
node node_modules/@playwright/test/cli.js test --config=playwright.invite.config.ts
$env:E2E_PORT = '3324'
$env:APP_ORIGIN = 'http://127.0.0.1:3324'
node node_modules/@playwright/test/cli.js test --config=playwright.config.ts --output=test-results/local
$env:APP_MODE = 'local'
$env:MODEL_PROVIDER = 'mock'
$env:DASHSCOPE_API_KEY = ''
$env:DASHSCOPE_BASE_URL = ''
$env:DATABASE_PATH = Join-Path (Get-Location) 'data/synthetic-build.db'
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:NODE_OPTIONS = '--require=./e2e/block-external-network.cjs'
pnpm build
```

mock 实际运行于此前同样无私密文件的副本 `C:/Projects/goal-coach-task4-check-0d023ce2-92ab-4efb-bd3c-0dee4ebf89ae`（匿名化历史路径），命令 `node node_modules/tsx/dist/cli.mjs evals/run.ts --provider=mock`，同样设置空凭据/mock/上述相对 preload；与 `pnpm eval` 的脚本体相同。结果目录为该副本下 `evals/results/mock-2026-09-20T03-32-05-761Z`。knownInputTokens=360、knownOutputTokens=180 是 mock 合成用量，绝非供应商账单；humanReviewStatus=unassessed。没有执行 `eval:live`。

## 截图与结果文件

以下均是本轮真实路径，保留供审查，不进入源码包。最终副本根为上文 `.../goal-coach-task4-check-1c049e19-d385-4bff-b4dd-932f995a7d83`：

- `test-results/invite/.last-run.json`：passed，无 failedTests。
- `test-results/local/.last-run.json`：passed，无 failedTests。
- `test-results/invite/invite-flow-invite-registr-8abf3--offline-readiness-at-375px-edge/login-mobile.png`
- 同目录 `admin-mobile.png`、`member-workspace-mobile.png`、`settings-mobile.png`、`logout-mobile.png`。
- `test-results/local/create-goal-creates-review-5f978-pens-the-formal-active-goal-edge/active-workspace-mobile.png`
- `test-results/local/complete-and-data-complete-5789f-e-isolated-harness-database-edge/goal-review-mobile.png`

已实际打开上述七张截图检查。邀请五张均为 375×812 视口的全页截图且测试断言无横溢；长页面需滚动，不把全页缩略图当真实字号。邀请码生成后先刷新让秘密消失再截图，登录截图字段为空。未启用邀请 trace/video/自动失败截图，避免记录注册密码和邀请码。原有本机套件还生成任务、重规划和设置等截图；这里只列已人工查看的代表图，不伪称逐张查看全部图像。

## 未执行边界

Docker/Podman 有限命令探测无可用项，未安装 Docker/WSL。因此没有实际镜像拉取、Linux 原生 SQLite 构建、Compose/Caddy 验证、非 root 卷挂载、TLS 证书签发或容器恢复通过的证据。目标主机命令已提供在[部署指南](../deployment/full-guide.zh-CN.md)与[运维手册](../deployment/operations.md)，不表示本机执行过。

没有真实 DNS/TLS、公有云购买/部署/恢复、真实 Qwen 调用/质量评分，也没有全新 Windows 安装验证。日限额不是账单硬上限，单进程限制不能外推到多实例。这些外部条件不要求用户重新手工跑一遍本轮软件测试。
