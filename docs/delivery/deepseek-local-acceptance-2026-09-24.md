# DeepSeek 接入、本机验收与香港部署准备记录

日期：2026-09-24。此文件是当前接入工作的记录，不把真实模型连通等同于整站或商业验收通过。项目路径 `C:\Projects\Goal-Coach`；源码基线 `b56047242138ba7997feca493131cc846716147a`。

## 当前结论（先读这里）

**DeepSeek 已接通，0.2.1 本机服务可以启动；完整业务验收未通过，尚不能作为正式邀请/商业上线版本。**

| 项目 | 当前证据与状态 |
| --- | --- |
| API 配置与真实连接 | 已验证，三轮分别获授权，共 25 次真实请求；第三轮已结束，不再自动追加 |
| 真实业务 | 第三轮 L01/L02 两例机器检查均通过；此前两例失败未复现，原因仍未证实，不能宣称已修复 |
| 最新离线回归 | 85 文件 1045 项 + CLI 2 文件 10 项，共 1055 项通过；TypeScript / ESLint 退出 0 |
| 离线评测 | 最新 30 例 mock 全部机器检查通过；不代表真实模型回答质量 |
| 本机浏览器 | 修正后隔离生产副本曾取得 14/14；最新本机入口健康检查 200 |
| 邀请浏览器 | 最新隔离两故事 2/2、无重试通过，证据已落盘；历史 GET/fetch `ERR_ABORTED` 未复现，原因未定位 |
| Docker / 公网 / 真机 | 未执行目标 Linux、HTTPS、恢复演练及真实手机验收；未部署上线 |

现有 0.2.1 是待验收工作区，不是已经通过全部测试的正式发布承诺。基础提交未变，本次修改尚未提交、推送或合并。

## 私密配置

首次程序检查未读到 Key，用户在准确路径重新保存后，服务端配置验证通过：提供方 DeepSeek、模型 `deepseek-flash`、单次输出上限 2048。程序加载 `.env.local` 后仅输出安全状态；未向聊天输出密钥或完整环境配置。配置检查不调用模型、不打开原练习数据库。

未停止或升级用户原 3000 实例，不对其当前运行状态作保证。原练习数据库 `data/practice-20260917-7e32f043-f8e8-4acf-9763-72c7ec120a7e/goal-coach.db` 保留，不直接用原数据库跑测试，也不上传本机配置到云端。

## 第一轮真实模型评测：已结束，有问题

用户明确授权：最多 5 个合成案例、20 次模型请求、每次最多输出 2048 token，运行一次后停止。这不是货币金额硬上限。

执行：`node --import tsx evals/run.ts --provider=deepseek --max-cases=5 --allow-live`。使用内存 SQLite，未使用原练习内容。Windows 普通沙箱的 tsx 用户信息读取失败后，在窄范围许可环境执行；这不是产品必须管理员运行的要求。

| 记录项 | 实际结果 |
| --- | --- |
| 范围 | L01–L05：5 个学习目标澄清案例 |
| 实际模型请求 | 8 次（授权最多 20 次） |
| 用量 | 已知输入 13584 token，输出 1525 token，无未知用量请求 |
| 接口 | 8 次均有响应，0 提供方错误；只读 get_goal 工具调用可用 |
| 安全/执行 | 0 崩溃、0 未经批准的正式结构写入；没有执行草案写入工具 |
| 原评分 | 2/5 通过，3/5 失败；进程退出码 1 |
| 内容核查 | 不能接受为质量通过：存在多余追问、内部字段输出、评分漏判 |

原始合成结果保留在被 Git/源码包排除的 `evals/results/deepseek-2026-09-24T09-25-29-489Z/`。没有自动重跑来替换失败记录。实际金额以 DeepSeek 平台账单为准；本工具仅记录输入/输出用量，不掌握该账户实际缓存计费及账单折算。

发现的问题：

- L01/L03 已给出可观察成果和时间容量，回答仍要求起算日期，没有生成待确认草案。当前上下文没有专门提供可信的“今天”日期。
- L02 在已有模拟协作成果时继续细问完成标准，并把内部状态和字段解释给用户；既有评分还要求用户未明确提出的“合并”关键词，需避免为了得分而添加要求。
- L04 实际问书籍版本，L05 实际问周末日期，却因其他段落提到时间而被评分误判为已问可用时间。
- L03 一个问号中包含起算日和时间分配两个问题，说明“数问号”不能保证只问一个问题。

据此，不把“2/5 原机器评分通过”写成两条内容质量已达标。更不宣称计划生成、重规划和复盘的真实模型闭环已验证。

## 已批准并完成的小范围修正

用户另行同意：补充可信日期、明确足够信息时创建待确认草案、简化用户表达、收紧评分；在离线检查通过后再做一轮最多 5 案例/20 次请求/每次 2048 输出 token 的付费复验。两轮均已结束，不能把剩余次数或“继续”视为下一轮自动收费授权。

- 服务器上下文增加 `currentDate` 和 `Asia/Shanghai`，午夜与跨年边界有测试。
- 提示词要求信息足够时生成待确认草案，不自行添加更高完成标准；推算日期/容量要标注假设。
- L04/L05 评分要求可用时间确实出现在追问中，不能从其他解释段落借关键词得分；覆盖“多久”“几个小时”等问法。
- L02 评分去掉用户未要求的“合并”必含项，不为通过评测而擅自扩张目标。

评分规则发生变化，第一轮 2/5 与第二轮 3/5 **不能直接作为同口径提升比例**。有限关键词规则仍不是语义质量证明。

## 第二轮真实模型复验：已结束，仍未通过

原始合成结果：`evals/results/deepseek-2026-09-24T09-44-24-902Z/`。同样使用内存数据库，每案例最多四次模型请求，每次最多输出 2048 token；没有重复执行本批次。

| 案例 | 请求数 | 实际结果 |
| --- | --- | --- |
| L01 TypeScript 待办网页 | 2 | 连续提出草案工具调用，触发 `AGENT_LIMIT_REACHED`；无待确认草案 |
| L02 Git 模拟协作 | 3 | 读取目标后连续提出草案工具调用，同样受控失败；无待确认草案 |
| L03 SQL 查询题 | 3 | 产生 1 份待确认草案；未改动正式目标，机器检查通过 |
| L04 阅读 | 2 | 询问每周可投入时间；机器检查通过 |
| L05 周末学习 | 1 | 询问周末总时间；机器检查通过 |

本批共 **11 次请求，输入 24354 / 输出 2315 token，未知用量 0**；机器检查 3/5，通过不足，进程退出码 1。记录中的 `crash` 字段包含这两次受控业务异常，不是 Node 进程崩溃。没有未经用户批准的正式结构写入。

另外，L03 回复称“限制条件和动机暂时留空”，而现有草案保存流程会补默认值并记录假设；不能把这条机器通过视为“文字与持久化结果完全一致”。SQL 草案日期 2026-10-29 来自评测固定时钟 2026-09-17，不是评测执行日取错了系统日期。

**两批合计：19 次真实请求，已知输入 37938 / 输出 3840 token，未知用量 0。**金额仍以账户实际账单为准；本文不估算或承诺人民币上限。

### 为什么现在不继续盲目重试

已有记录只有工具名，未保存工具参数或校验问题。它能说明重复工具调用被保护机制拦截，不能证明是哪一个参数错误。内存评测库已关闭，不能从缺失的证据倒推出具体字段。暂未放宽 schema、去掉防重复限制或增加循环次数。

本次继续工作增加**仅在评测器使用**的 `argumentDiagnostics`：复用真实工具 schema，输出白名单字段路径、校验码和已知跨字段规则代号；不保存原始参数、校验消息、枚举实际值、动态属性名和调用 ID。不改变模型响应或业务执行器。旧记录保持字段缺失，未伪造回填。TDD 首次 5 个预期失败、1 个兼容性通过，实现后 6/6 通过；评测相关 3 文件 34 项通过，随后完整离线回归通过。

随后用户明确批准了仅针对 L01/L02 的新一轮诊断：最多 8 次请求、每次最多输出 2048 token，单批结束即停。实际执行如下；该授权已经使用并结束，不自动构成计划、重排、复盘全流程验收或下一批调用许可。

## 第三轮受限诊断：2 例通过，故障未复现

结果目录：`evals/results/deepseek-2026-09-24T12-32-47-426Z/`。执行前在同一进程加载并校验私密配置：必须为 `deepseek-flash`、2048 输出 token，否则零派发退出。评测固定 `maxCases: 2`，编排器每例最多四次请求，供应商客户端自动重试为 0。使用合成输入与内存库，没有访问用户真实目标。

| 案例 | 请求 / 工具 | 草案结果 | 脱敏诊断 |
| --- | --- | --- | --- |
| L01 TypeScript | 3 次请求；读取目标 → 草案 → 回复 | 1 份待确认草案，4 周、每周 420 分钟、保留待办网页成果 | 两个工具参数均 valid，无校验问题 |
| L02 Git | 3 次请求；读取目标 → 草案 → 回复 | 1 份待确认草案，2 周、每周 210 分钟、保留模拟协作成果 | 两个工具参数均 valid，无校验问题 |

本批实际 **6 次请求**，输入 **14317** / 输出 **1056** token，未知用量 0；业务异常 0，未经批准的正式结构写入 0，机器检查失败 0，进程退出 0。剩余 2 次未使用，不自动补跑。**三轮累计 25 次请求，输入 52255 / 输出 4896 token**；人民币金额以实际账单为准。

内容核查：两例均没有继续索要起算日，没有新增“独立完成、无提示、全部通过、强制合并”等完成条件；回复说明了时间换算假设并引导查看/批准草案。L01 的“基本待办功能”仍是宽泛成果描述，具体可验收任务需要后续计划阶段落实；它不是一份已生成的详细开发计划。L02 提及“动机待定”，现有评测只导出四个契约摘要字段，未完整导出动机和假设，不能据此声称全部文字与持久化字段已逐项一致。工具参数合法不等于用户可见内容完全准确。

结论是**同一业务代码下两例本次成功，但先前失败的具体参数根因仍未捕获**。本批只有评测观测增强，没有针对该失败修改业务逻辑，不能把通过归因于已经修好某个参数，也不能删除第二轮失败记录。没有为了得出绿色结果再跑第四批。

### 完整业务验收仍缺什么

| 流程 | 当前真实模型覆盖 | 下一阶段需要的证据 |
| --- | --- | --- |
| 目标澄清 / 契约草案 | L01–L05 受限案例；成功与失败记录并存 | 对失败可诊断；回复与完整保存草案一致 |
| 用户批准契约 | 当前主要是 mock / 服务与浏览器测试 | 同一个合成目标经可信界面批准，模型不能自己批准 |
| 生成计划 / 批准计划 | 尚未做真实模型闭环验收 | 里程碑、任务依赖、容量与完成证据可用；批准后才正式生效 |
| 执行 / 阻碍 / 重规划 | 现有离线和浏览器证据，不是实际 DeepSeek 闭环 | 实际状态被读取、调整理由具体、重排等待批准、统一撤销有效 |
| 目标复盘 | 尚未做真实模型闭环验收 | 复盘基于实际执行证据而非虚构进展 |
| 云端邀请 / PWA | 尚未部署目标主机 | HTTPS、账号隔离、配额、备份恢复与真实手机实测 |

后续若组织付费验收，应先离线准备同一合成目标的端到端流程和明确总请求限额，再单独申请授权；不能继续用反复通过前两例冒充全流程验收。

## 本轮离线基线（修正前）

- TypeScript、ESLint：退出 0。
- 单元/集成：主批 83 文件 1018 项通过，随后脚本批 2 文件 10 项通过，共 1028 项；均退出 0。
- 30 例 mock：0 崩溃、0 未批准结构写入、0 机器失败；只是确定性回归，不是内容质量证明。
- 本机生产浏览器：新隔离副本 `dist/goal-coach-pwa-preview-els8TH`，回环 3401，14/14 通过、退出 0。含生产构建、目标/计划确认、任务、撤销、复盘、数据操作、安全边界与异常恢复。
- 邀请/PWA：同隔离源码、独立合成库、回环 3402，PWA 故事通过；邀请故事全部业务断言执行后，最终诊断捕获 GET/fetch/非导航 `ERR_ABORTED`，该故事失败；合计 1 通过、1 失败，退出 1。没有把失败忽略或改报全绿。

上述浏览器夹具清空模型凭据、阻断外网、只操作自有测试库和进程；不会读取 `.env.local` 或请求 DeepSeek。邀请请求取消正在独立定位，未证明原因前不当作无害过滤。

## 修正后及本次继续的离线检查

- 修正后生产副本 `dist/goal-coach-pwa-preview-Ul3CYV`：本机浏览器 3403 端口 14/14、退出 0；邀请/PWA 3404 端口 1 通过、1 失败，仍捕获 `member-workspace` 阶段的 GET/fetch/非导航 `ERR_ABORTED`。
- 邀请诊断增加脱敏路由模板、请求起止阶段、RSC/prefetch 布尔值和工作区步骤；没有删除或过滤最终异常断言。
- 独立探针：3411 业务断言通过但沙箱进程清理失败；3412 聚焦故事通过；`dist/goal-coach-pwa-preview-fIvvr4` 的 3413 邀请/PWA 两故事通过、退出 0。此前失败仍保留，不能宣称间歇问题已修复。
- 本次继续使用干净测试环境（清除测试命令继承的 `APP_ORIGIN`、`APP_MODE`、`E2E_PORT`、`NODE_OPTIONS`，不修改配置文件）运行主批 85 文件 1045 项、CLI 批 2 文件 10 项，均退出 0。CLI 因已确认的沙箱 tsx 用户信息限制窄范围提升执行；不是产品要求管理员运行。
- TypeScript 与 ESLint 均退出 0。
- 最新独立 mock 评测：`evals/results/mock-2026-09-24T11-54-36-380Z/`，30 例、36 次模拟响应、0 业务异常、0 未批准结构写入、0 机器失败，退出 0；没有访问外部模型。

### 第三轮真实诊断后的免费浏览器复核

独立副本 `dist/goal-coach-pwa-preview-NwEblF`，回环端口 3414，仅执行一次邀请全套，**2/2 通过、退出 0、46.9 秒、重试 0**：

1. `invite registration, private goals, logout and offline readiness at 375px`：通过，9542ms。
2. `production PWA uses only public offline cache across two invited accounts`：通过，7970ms。

JSON 统计 `unexpected: 0`、`flaky: 0`、`errors: []`。脱敏浏览器附件为 `unexpected: []`、`phase: member-logout`、`modelRequests: 3`（mock，不是 DeepSeek 请求）。使用合成临时库、空供应商凭据和外网阻断；清理成功，3414 已释放。没有改共享测试或产品代码，没有过滤历史错误，也没有继续重跑。

真实落盘证据（均被源码包/Git 排除）：

- `dist/goal-coach-pwa-preview-NwEblF/test-results/invite-diagnostic.json`
- `dist/goal-coach-pwa-preview-NwEblF/test-results/browser-evidence.decoded.json`

主 Agent 独立读取报告，并逐字节核对副本 `src/public/e2e/e2e-invite` 共 255 个文件与工作区一致。只在隔离副本增加 JSON reporter 和本环境所需 Turbopack root 配置。旧请求取消未复现，仍不能声称已定位是业务接口错误、导航取消或测试问题。

本次还对新手教程的 15 个 Bash 代码块执行 `bash -n`，语法检查全部通过；这不是执行服务器命令，更不证明 Docker、HTTPS 或备份恢复已在 Linux 上运行。

### 保留失败的探针记录

此前并行负载探针继承了邀请服务器 `APP_ORIGIN=...3413` 和相对路径 `NODE_OPTIONS`，其 Vitest 结果为 1031 通过、18 失败。该探针在浏览器开始前已结束，不能称为成功的并行负载验收；也不能仅凭环境解释把 18 个失败删除。它们在上述干净环境主批/CLI 批中随后通过：

- `src/app/api/api.integration.test.ts` 的 10 项：
  - rejects invalid agent input through the fixed safe envelope before opening runtime data
  - serves list/create/workspace, refuses ownership/scenario injection and returns uncached data
  - updates task execution idempotently, undoes it, creates and rejects an offline draft
  - saves contract edits through the existing route without approving them
  - bootstraps manual contracts on the same endpoint and rejects ambiguous or forged creation fields
  - settings and preference routes never disclose private credentials and clear obeys generation
  - settings exposes only key presence on GET and PATCH and rejects derived or secret writes
  - preference API accepts exact bounds and rejects overflow or wrong types without writing
  - rejects deletes without UI confirmation and supports a displayed-version confirmed deletion
  - agent failures preserve exact safe envelope, saved-change notice and first-error replay
- `src/server/security/origin-guard.test.ts`：allows canonical local origin for POST / PUT / PATCH / DELETE，共 4 项；与上一组共 14 项涉及错误的继承 Origin。
- `scripts/local-app.test.mjs`：CLI check reports missing local requirements without reading env contents or changing files；start runs the installed Next CLI in the foreground with loopback args and inherited database path。
- `scripts/package-source.test.mjs`：CLI copies allowlisted source bytes with independent SHA-256 hashes and excludes private data。连同上两项，3 项涉及子进程切换目录后的相对 `NODE_OPTIONS`。
- `src/server/auth/auth.test.ts`：generic login errors and CLI reset invalidate all sessions and old password，曾超过 5000ms；其超时根因未独立证明，不仅凭后来通过就称负载问题已解决。

## 现在从哪里打开，以及重启方法

入口：`http://127.0.0.1:3400/`，仅供这台电脑访问，不是给朋友的公网地址。当前以生产构建启动的副本为 `dist/goal-coach-pwa-preview-Ul3CYV`；它包含本次业务提示词/日期修正，后增的评测诊断不属于网页运行代码。

新数据库为 `data/local-deepseek-20260924-5d88a1c7/goal-coach.db`，与原练习库分开。已有一次不调用模型的持久化验收：创建唯一合成目标 → 停止本轮自有进程 → 同库重启 → 成功读回 → 按准确 ID/版本/确认短语删除仅该合成目标。测试目标已删除，原数据未动。中断后本次再次启动，`/api/health`、`/api/settings/model-readiness`、`/api/goals` 均 200，目标列表为空。

模型检查返回 `configured: true`、`liveVerified: false` 是设计行为：该接口只读配置，从不发收费请求，也不记录外部评测是否成功。不能把这个布尔值解释为 Key 不可用；同样也不能改为 true 来冒充业务验收。

若窗口/电脑关闭导致入口不可访问，先确认 3400 没有其他程序占用；仅在未运行时用 **Windows PowerShell** 执行下面命令，保持窗口开启。不要再次迁移原数据库，不需要重新安装依赖：

```powershell
Set-Location 'C:\Projects\Goal-Coach\dist\goal-coach-pwa-preview-Ul3CYV'
$env:PATH = 'D:\NodeJS;' + $env:PATH
$env:DATABASE_PATH = 'C:\Projects\Goal-Coach\data\local-deepseek-20260924-5d88a1c7\goal-coach.db'
$env:APP_MODE = 'local'
$env:APP_ORIGIN = 'http://127.0.0.1:3400'
$env:NEXT_TELEMETRY_DISABLED = '1'
& 'node' --env-file='C:\Projects\Goal-Coach\.env.local' node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3400
```

这里的 Key 由进程私下读取，不输出文件内容；显式数据库环境变量保护原练习库。副本依赖项目 `node_modules` 链接，不能单独拷走当便携版，也不要递归删除该副本。使用结束以该窗口 `Ctrl+C` 停止自己启动的实例。在页面同意模型数据使用并发送目标/消息会真实计费，不属于上述不收费的健康检查。

## 部署与交付边界

[香港 Docker 新手教程](../deployment/aliyun-hong-kong-docker-beginner.zh-CN.md)覆盖 Key、本机、ECS、安全组、SSH、DNS、Docker、HTTPS、邀请、PWA、备份、恢复与排错。官方来源核验不等于实际部署。

当前没有购买/操作你的阿里云服务器、域名或 DNS；当前开发机没有 Docker/可用 WSL。因此 Linux 镜像构建、UID 1000 卷权限、Caddy 证书、服务器重启与恢复、真实手机均不能标记为已通过。交付教程中的服务器命令需要在你准备好目标主机后逐步验证。

第一轮源码包 0.2.0 是历史基线，未被覆盖。第三轮前已生成 0.2.1 待验收源码快照，325 个源文件加清单，共 326 文件；其包名、逐文件核验和 ZIP 哈希记录在 `dist/goal-coach-0.2.1-handoff.md` 与包旁 `.sha256` 文件，避免循环哈希。**源码快照不等于已验收发布包；第三轮后仅更新工作区文档与包外收据，未改写旧 ZIP，所以包内验收文档仍是之前的记录。**

上线顺序：先定位并修复两例真实草案失败和回复/落库一致性，完成另行授权的真实业务复验 → 查明邀请浏览器间歇问题 → 选定目标主机执行 Docker/权限/HTTPS/备份恢复/配额测试 → 真机 PWA 验收 → 邀请 3–5 位朋友做价值试用。未经这些阶段，不承诺“开箱即用完整功能”或商业效果。
