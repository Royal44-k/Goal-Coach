# 本机 MVP 验收记录

记录日期：2026-09-17（Asia/Shanghai）；验收权限更新：2026-09-18。本文件把自动化证据、真实模型证据、人工观察和可选个人学习分开记录。软件验证由代理使用隔离合成数据执行，不要求用户手工复测；个人练习和知识自查可选、默认未评定，不阻塞软件验收。`待验证` 不是通过；只有实际运行、读取退出码并保存对应观察后才能改为通过。

## 当前离线交付范围与已知缺口（2026-09-18）

用户最新要求为“没有，保留接口配置”。本轮保留 Qwen 接口与配置入口，不配置 Key、不激活真实模型；live smoke、真实模型质量和配对人工评分均延期，既非通过也非失败，不阻塞本轮离线检查点。全新 Windows 启动仍未验证，可选个人学习未评定，线上邀请分享未实现。原始规格的完整完成定义仍保留。

原已知非阻塞残余要求 M3 已在当前代码中关闭：原规格 8.3 的 `record_check_in` 与任务修改现在共用“撤销上一次修改”。任务修改恢复状态和实际分钟数；打卡/阻碍反馈保留历史并标记撤销，不再参与当前建议、偏好推导与复盘事实。源码交付辅助工具及其最终产物验证以 `docs/delivery/verification-2026-09-18.md` 的实际记录为准；全新 Windows、真实模型质量和线上邀请分享仍未由这一实现证明。

最终审查修复统一了当前计划非空且每项均 done 的复盘资格，排除 skipped；服务完成还要求精确关联的成功保存复盘，保留历史复盘警告和当前数据显式确认。模型上下文复用当前计划任务沿袭/执行重置投影，只提供最近 10 条相关打卡，每条备注最多 1000 个 Unicode 码点，兼顾最近反馈与请求大小；提供确定性重规划触发码/原因和最新相关可用分钟数，不暴露原始 Operation、Undo、ApprovalGrant 或私有文件。

## 2026-09-18 最终修复后自动验证

- `pnpm verify`：ESLint、类型检查、65 个测试文件 / 806 项测试及 Next.js 生产构建全部通过（退出码 0）。保持 Node.js 24.20.0 / pnpm 11.19.0，未安装或升级依赖。
- `pnpm test:coverage`：806/806 通过；配置内 7 个关键文件分支覆盖率 98.82%（335/339），逐文件最低 98.21%。这不是整个项目的覆盖率。
- `pnpm eval`：离线 30/30，崩溃、未批准结构写入和机器判定失败均为 0；结果目录 `evals/results/mock-2026-09-18T06-32-04-629Z`。合成用量和离线结果不代表真实模型质量或人工评分。
- 完整生产 Edge 浏览器测试：12/12 通过（退出码 0，1.8 分钟），包括 45 秒超时、响应丢失后的精确重放，以及新增的复盘失败恢复、重试、保存复盘后确认完成流程。结果目录 `.superpowers/sdd/2026-09-04-local-goal-coach-mvp/screenshots/final-fix-e2e-20260918`。
- 所有自动测试使用隔离数据库；原练习数据库及 WAL/SHM 在测试前后 SHA-256 相同。随后使用相同数据恢复预览，HTTP 200、原目标和待确认草案可见，浏览器捕获的警告/错误为空；未提交用户表单或改变正式任务。

本节保存的是 2026-09-18 当时源代码的运行证据，以下表格及较早记录按各自原日期解读，不代表当前交付 HEAD 的最新结果。对应独立限范围复查和历史扫描记录保存在 `.superpowers/sdd/2026-09-04-local-goal-coach-mvp/final-fix-runtime-report.md`。当时尚存的 M3 缺口后来由统一撤销关闭；真实模型、干净 Windows 和线上分享边界仍不因旧自动测试通过而改变。当前交付证据另见 `docs/delivery/verification-2026-09-18.md`。

## 2026-09-18 代理自动复验（最终修复前）

本轮使用独立测试数据库；保留原练习数据，不调用付费模型。

- `pnpm test:coverage`：62 个文件、778 项通过；配置内关键模块分支覆盖率 98.82%（335/339）。
- `pnpm eval`：离线 30/30，崩溃、未批准结构写入和机器判定失败均为 0；真人评分未评定。结果目录：`evals/results/mock-2026-09-18T04-51-56-644Z`。
- 首轮浏览器检查为 10/11：恢复用例在请求仍在途时提前断言。确认并修正测试等待条件后，该用例连续 5/5 通过；未修改应用行为或削弱原有断言。
- 最后 `pnpm verify`（ESLint、类型检查、778 项测试、生产构建）及完整生产 Edge 11/11 均 exit 0，会话 `28776`。45 秒超时场景耗时 49.2 秒；响应丢失后的精确重放耗时 2.7 秒。结果目录：`.superpowers/sdd/2026-09-04-local-goal-coach-mvp/screenshots/task-19-e2e-runs/final-20260918-autonomous`。
- README 的 7 段 PowerShell 命令静态解析无语法错误，但这不等于已在全新 Windows 环境实际安装；未执行安装或升级。

已知终端颜色变量警告及 Vitest 性能建议仍有输出，不宣称零警告。本节更新本轮离线证据；以下较早的生产重启等记录仍按其原日期解读。真实模型质量、干净 Windows、最终提交历史扫描与发布状态不由离线通过自动推导。

## 完成定义逐项证据

| 规格第 17 节条件 | 证明命令或操作 | 当前输出摘要 | 人工观察 | 状态 |
| --- | --- | --- | --- | --- |
| 1. 所有范围内用户流程可在生产构建中完成 | `pnpm build`、`pnpm start`；在一次性 GUID 数据目录完成创建→契约→计划→执行→阻碍→重规划→完成→复盘→导出→清除，并执行下述停止/重启检查 | 生产 Edge 11/11；owned synthetic `db:migrate`/build/start 均 exit 0。PID 28024 停止后用同一显式 mock DB 由 PID 32896 重启，正式 SHA-256 完全一致；导出和精确短语清除通过 | 新进程/新浏览器显示完成状态和已保存复盘；清除后 0 goals 且 onboarding 可见 | 合成生产流程通过；不依赖用户手工复测 |
| 2. 所有自动化测试和 30 个评测案例达到门槛 | `pnpm lint`; `pnpm typecheck`; `pnpm test:coverage`; `pnpm eval`; `pnpm e2e`; `pnpm build` | fresh precommit 会话 `59307`：`verify`（ESLint、tsc、Vitest、Next 16.3.4 production build）exit 0，62 files、778/778 tests，19:22:51 完成。fresh mock eval 30/30、0 crash、0 unauthorized structural write、0 machine failure。会话 `41902`：生产 Edge 11/11。真实 Qwen 30 案、配对人工评分仍未授权/执行 | mock 结果不能证明真实模型质量；人工均分必须来自逐案匹配的真实评审 | 本地离线 precommit 自动化通过；真实模型/人工质量待验证 |
| 3. 密钥扫描和敏感文件检查无泄漏 | `git ls-files .env.local data evals/results coverage playwright-report test-results`；对交付 HEAD 运行不回显候选内容的有界 Git 历史扫描 | precommit tracked-sensitive-path query 无输出，diff-check exit 0（仅已知 CRLF 提示）。基线 `ff30931`：40 commits、4104 commit/path pairs、393 unique blobs、7,406,766 bytes、四类签名 0 findings、无跳过/超限；交付 HEAD 必须重扫 | 未读取私有 `.env.local`、忽略文件或用户数据库；扫描范围和局限见下文 | 跟踪路径通过、基线扫描通过；交付 HEAD 历史扫描待验证 |
| 4. 全新 Windows 环境按 README 验证成功 | 在用户批准的干净 Windows profile/一次性 VM 中按 README 运行版本检查、`pnpm install`、安全配置、迁移、`pnpm build`、`pnpm start` | 尚无合格环境和计时记录 | 待记录开始/结束时间、每条命令退出码、15 分钟内生产首页是否加载 | 待验证 |
| 5. 明确记录线上邀请试用版为独立后续 | 检查 README 和本文件 | 已记录边界 | 本地通过不能推导多用户、认证、部署已实现 | 已记录 |
| 可选教学（非规格第 17 节完成条件）：个人知识自查 | 用户可选回答 `docs/learning/README.md` 八节问题 | 自动化不能代答，也无需代答 | 如果用户选择参与，只记录有证据的 `通过` 或 `需复习` | 可选、未评定；不阻塞软件验收 |
| 可选教学（非规格第 17 节完成条件）：亲自完成一个目标 | 用户可选使用本机一次性非敏感目标练习创建、批准、执行、证据和复盘 | 尚无用户参与证据 | 如果用户选择参与，只记录日期和阶段结果，不记录目标正文、Key 或私人数据 | 可选、未评定；不阻塞软件验收 |

线上邀请试用版尚未实现，必须另行设计和计划。

## 定量门槛与独立证据

| 门槛 | 需要的证据 | 当前状态 |
| --- | --- | --- |
| 未批准结构性或删除操作拦截率 100% | 浏览器安全边界 + `src/server/agent/tool-registry.test.ts`、`permission-gate.test.ts`、`src/server/security/approval-service.test.ts` | fresh precommit 生产 Edge 11/11 通过，其中安全边界 5/5；fresh verify 778/778 通过 |
| operationId 重放重复写入 0 | 实际上游 task PATCH 已提交后丢弃浏览器响应，再以完全相同正文/ID 查询 | precommit 重放用例 2.5 s 通过；精确正文/ID、上游结果、版本和 reload 状态一致 |
| 应用崩溃数 0 | mock 30 案和经授权的真实 Qwen 30 案 | mock 30/30、0 crash；真实 Qwen 30 案未授权/未执行 |
| 核心模块分支覆盖率至少 90% | `pnpm test:coverage` 并读取逐模块分支摘要 | 关键 7 文件 branches 98.82% (335/339)，逐文件最低 98.21% |
| 刷新、进程重启、超时和断网不丢正式数据 | timeout fixture、真实 PATCH 丢响应、生产进程停止/重启 | precommit 45 秒 HTTP timeout 用例 49.2 s、丢响应重放 2.5 s；同库进程重启前后正式 SHA-256 均为 `bf925979997e968d57c94f1c808db183e878d94ce551d79022a8359a1e58ad4b` |
| 撤销、导出、全部清除 | 生产一次性数据流程 | 代理合成流程覆盖撤销；owned synthetic export 验证 1 goal/3 tasks/3 evidence 和公开键；精确短语清除后 0 goals/onboarding visible。个人练习可选且未评定 |
| 人工计划质量平均分至少 4/5 | 与真实 Qwen 30 案结果目录严格匹配的人类 review 文件及 `evals/score.ts` | 未授权/未执行；不得用机器生成评分代替 |
| 干净 Windows 15 分钟启动 | 下文计时记录 | 待验证 |

首次 5 案及后续 30 案真实 Qwen 调用均需单独授权。30 案协议上限是每案最多 4 次模型调用，即理论最多 120 次供应商调用；本机 Token 守卫不等于已核实的供应商账单上限，Codex 额度也不能证明 Qwen 余额。

fresh precommit mock 结果目录为 `evals/results/mock-2026-09-17T11-23-17-814Z`：36 actual attempts / 120 protocol bound，最大 executor 1，已知合成用量 360 input / 180 output，unknown usage 0，人工评分未评估。precommit Edge artifacts 位于 `.superpowers/sdd/2026-09-04-local-goal-coach-mvp/screenshots/task-19-e2e-runs/precommit`；已核实的超时手动模式截图还保存在 `.superpowers/sdd/2026-09-04-local-goal-coach-mvp/screenshots/task-19-e2e-runs/retry-1/offline-and-recovery-shows-1fd20-plicating-the-saved-blocker-edge/timeout-manual-mode-desktop.png`。

## 一次性生产重启与持久化步骤

该步骤已由控制器在无并发 build/dev/start 写入者时执行。实际目录为 `%TEMP%\goal-coach-prod-81830af1-265e-45ec-8ca2-eda1db27988b`，数据库为其下 `goal-coach.db`；操作前验证了 GUID 目录归本次会话所有且目标数据库原先不存在，所有子进程均显式使用该 `DATABASE_PATH` 与 `MODEL_PROVIDER=mock`。迁移 CLI 和 Next.js 正常执行了 dotenv 加载；没有工具/模型检查或打印私有配置内容，也没有对默认用户数据库执行操作，但这不被表述为进程绝对没有读取环境文件。

1. 四地址独占绑定检查通过后，`pnpm db:migrate` 和 `pnpm build` 均 exit 0；首次 `pnpm start` 捕获 owned wrapper PID 28024，并验证 executable、StartTime、HTTP 200 和标题。
2. 固定 mock 流程完成 Goal `e38a4436-5e6d-417d-9218-cb35bcf5e380`：version 17、3 个 version 3 的完成任务、3 条 evidence、已保存 reflection。所选正式 JSON SHA-256 为 `bf925979997e968d57c94f1c808db183e878d94ce551d79022a8359a1e58ad4b`。
3. 控制器再次核对 PID 28024 的 executable 和精确 StartTime，使用 owned `taskkill /PID 28024 /T /F` 受控强制停止进程树；`WaitForExit` 为 true、PID 消失、四地址均可独占绑定。这不是 graceful shutdown，也不是普通 reload。
4. 使用同一 `DATABASE_PATH` 重启为 owned wrapper PID 32896；新进程/新浏览器读取到完全相同的正式 SHA-256、version 17、3 tasks、3 evidence 和已保存 reflection。
5. synthetic export `goal-coach-export-2026-09-17.json` 验证 1 goal/3 tasks/3 evidence、公开顶层键，且无 apiKey/approvalGrant/operationId/operations。随后只在该 fixture 输入精确短语 `清除我的全部本地数据`，核对 0 goals、onboarding visible、0 page errors。
6. 控制器核对 PID 32896 的 executable/StartTime 后，同样受控强制停止 captured tree；PID 消失、四地址均可独占绑定。最终只删除解析并验证过的 exact GUID 临时目录，`Test-Path` 为 false；三个遗留 Task 14 目录未动。日志、截图和报告保存在 `.superpowers/sdd/2026-09-04-local-goal-coach-mvp/production-81830af1`。

## 有界、净化的 Git 历史扫描

扫描器必须枚举 `git rev-list --all` 的可达提交和递归 tree，使用 `git cat-file --batch` 按声明字节边界读取每个唯一 blob 一次。它只输出 commit/path/category/count/status，不输出匹配文本、patch、Git stderr 或凭证值。上限为 100 commits、20,000 commit/path pairs、3,000 unique blobs、单 blob 2,097,152 bytes、总缓冲 67,108,864 bytes；解析失败、超限或遗漏必须报告 `BLOCKED/UNSCANNED`，不能报告通过。

基线 `ff30931e6821c1607c27368fe007371d758b8fd0` 的结果保存在 `.superpowers/sdd/2026-09-04-local-goal-coach-mvp/task-19-history-scan-ff30931.md`。其四类高信号检测为私钥头、供应商 Key 形状、带引号凭证赋值和 literal bearer。该结果不覆盖混淆格式、忽略的私有文件或后续提交，所以交付 HEAD 必须刷新扫描。

## 干净 Windows 15 分钟记录

| 项目 | 记录 |
| --- | --- |
| 环境 | 待用户批准的干净 Windows profile 或一次性 VM；Node/Git 可预装 |
| 开始时间（含时区） | 待记录 |
| 结束时间（含时区） | 待记录 |
| `node --version` | 待记录，应为 `v24.20.0` |
| `pnpm --version` | 待记录，应为 `11.19.0` |
| README 每条命令退出码 | 待记录 |
| 生产首页加载 | 待记录，仅 `http://127.0.0.1:3000` |
| 总时长是否 ≤ 15 分钟 | 待验证 |

已配置的开发 worktree、缓存依赖和既有数据库不能替代这项证据。若没有合格环境，本门槛保持待验证。

## 可选学习与实操记录（不阻塞软件验收）

用户如希望学习，可选解释并演示：AgentState 与 GoalStatus、model—tool loop、Zod 边界、Permission Gate、ApprovalGrant、operationId、乐观版本、最小上下文、mock 与 live 评测区别，以及离线时为何仍可用已有批准计划的手动控件。这些结果当前未评定，不是软件完成门槛。初始计划尚未生成任务时，不得声称存在任务编辑器。

| 验收项 | 结果 | 日期/备注（不含私人内容） |
| --- | --- | --- |
| 十个概念解释 | 可选、未评定 | 有用户实际证据时才记录 |
| 创建到复盘完整操作 | 可选、未评定 | 有用户实际证据时才记录 |
