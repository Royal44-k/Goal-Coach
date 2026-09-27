> 历史设计/执行记录，保留当时决策；路径已匿名化。当前行为、默认值和发布权限以仓库当前规格及本次发布说明为准。

# 本地自适应目标教练 MVP 设计规格

**状态：** 已批准产品设计的第一里程碑实施规格

**上位设计：** `docs/superpowers/specs/2026-09-02-adaptive-goal-coach-design.md`

**实施范围：** Windows 本机、单用户、中文 Web 应用

## 1. 交付目标

交付一款可以在用户电脑上通过浏览器运行的自适应目标教练 Agent。它支持学习目标和轻量工作目标，能够澄清目标、生成目标契约、生成计划草案、等待明确批准、保存计划、推荐当前最佳行动、记录执行反馈、诊断阻碍、提出重规划并完成复盘。

本里程碑结束时必须同时交付：

- 可运行的本机生产构建。
- 自动化测试和 30 个案例的 Agent 评测集。
- 中文安装、配置、使用、测试和故障排查说明。
- 面向初学者的逐阶段学习记录。
- 不包含任何真实 API Key 的 Git 历史。

## 2. 范围边界

### 2.1 包含

- 单个固定本地用户。
- 多个目标，一次会话聚焦一个目标。
- 目标澄清、目标契约和人工批准。
- 里程碑、计划版本和 3～8 个当前窗口任务。
- 当前最佳行动。
- 任务查看、编辑、完成、删除和撤销。
- 执行反馈、阻碍诊断和重规划草案。
- 文本说明、文件元数据、检查问题答案或用户声明形式的完成证据。
- 本地数据导出和全部清除。
- 模型不可用时的手动任务管理。

### 2.2 排除

- 邀请码、账号登录、多用户数据和 PostgreSQL。
- 公网部署、域名、HTTPS、Docker 和云服务器。
- 外贸单证核验 Agent 的任何能力。
- 联网搜索、RAG、多 Agent、模型微调和 MCP 服务开发。
- 日历、邮件、消息通知和第三方任务平台。
- 读取上传文件正文或验证证据真实性。
- 医疗、法律、投资及违法有害目标规划。

线上邀请试用版必须在本 MVP 验收后重新进行独立规格确认和实施规划。

## 3. 主要用户流程

### 3.1 创建目标

1. 用户输入一个学习或轻量工作目标。
2. Agent 检查期望成果、完成定义、截止日期、每周时间、限制和动机。
3. 每轮至多追问一个问题，至多主动追问三轮。
4. 非关键字段缺失时列出默认假设；期望成果或完成定义缺失时不能进入计划审批。
5. Agent 生成目标契约草案。
6. 用户编辑、要求修改或点击批准。
7. 服务端为当前草案创建一次性批准凭证并保存正式契约。
8. Agent 生成含里程碑和 3～8 个任务的计划草案。
9. 用户查看计划差异并点击批准。
10. 服务端验证批准凭证后保存计划版本并激活目标。

### 3.2 执行目标

1. 首页显示 Planning Engine 选出的当前最佳行动。
2. 用户可以开始任务、记录进度、标记完成或报告阻碍。
3. 明确的状态修改可以执行并生成可撤销记录。
4. Agent 建议的结构变化只能形成草案。
5. 页面始终从数据库读取正式状态，不以模型回复作为事实来源。

### 3.3 卡住与重规划

1. 用户点击“我卡住了”或输入等价表达。
2. Agent 把阻碍归类并提出最小下一步或计划调整。
3. 不改变任务结构的建议直接展示。
4. 涉及新增、删除、移动、期限或依赖的建议形成新 PlanVersion 草案。
5. 用户查看差异并批准后，新版本取代旧版本。

### 3.4 完成与复盘

1. 用户提交任务约定形式的完成证据。
2. 系统验证证据形式并允许用户确认任务完成。
3. 所有必要任务完成后，Agent 生成目标复盘。
4. 用户确认复盘后，目标状态改为 `completed`。

## 4. 页面与交互

本 MVP 包含以下页面或主要视图：

- 首次使用与隐私说明。
- 目标列表。
- 新目标对话。
- 目标契约审阅。
- 计划草案与版本差异审阅。
- 当前目标工作台。
- 任务编辑和完成证据对话框。
- 阻碍诊断与重规划审阅。
- 目标复盘。
- 数据导出、清除和模型设置。

所有结构性写入按钮必须明确显示将被保存的版本。删除和清除使用二次确认，不以颜色或图标代替文字说明。错误消息使用用户可行动语言，并提供重试、返回安全状态或继续手动管理的入口。

## 5. 技术架构

### 5.1 技术栈

- Node.js 24.20.0 LTS。
- pnpm 11.19.0。
- Next.js 16.x 稳定补丁版，App Router，Node.js Runtime。
- React、TypeScript 严格模式；TypeScript 7 CLI 与 TypeScript 6 compatibility API 按官方方案并行安装，供尚未支持 TypeScript 7 API 的 ESLint 工具使用。
- Zod。
- Drizzle ORM 与 SQLite。
- 百炼 OpenAI 兼容 Chat Completions API。
- 主模型 `qwen3.7-flash-2026-07-15`。
- 默认禁用的备选模型 `qwen3.7-plus-2026-05-26`。
- Vitest、React Testing Library、Playwright。

依赖的精确补丁版本由实施开始时的锁文件固定，后续开发不得无关升级。2026-09-14 复查确认当前系统为 Node 24.20.0，满足 Next.js、pnpm、better-sqlite3 和 jsdom 的 Node 要求；2026-09-15 用户同意继续完成依赖同步和实际验证。

### 5.2 组件

- `Web UI`：渲染用户可见状态并收集明确确认。
- `Route Handlers`：处理 HTTP、输入校验和响应。
- `Agent Orchestrator`：驱动状态机、模型和工具循环。
- `Prompt Builder`：构建最小上下文与当前允许的工具。
- `Qwen Client`：封装协议、超时、一次安全重试和用量。
- `Tool Registry`：暴露经过 Zod 描述的工具。
- `Permission Gate`：验证状态、明确意图、ownerId 和批准凭证。
- `Planning Engine`：确定性计算进度、风险、依赖、排序和差异。
- `Repository`：通过事务持久化 SQLite。
- `Audit Logger`：记录批准、工具执行、版本变化和错误类型。

模型和 UI 均不得直接操作数据库。

## 6. 状态机

状态为：

- `intake`
- `clarifying`
- `contract_review`
- `planning`
- `plan_review`
- `active`
- `reviewing`
- `replanning`
- `paused`
- `completed`
- `failed_recoverable`

主要转换：

```text
intake → clarifying → contract_review → planning → plan_review → active
intake → contract_review（输入已包含全部关键字段时）
clarifying → clarifying（仍需追问且未达到三轮上限时）
active → reviewing → active
active → replanning → plan_review → active
active ↔ paused
active → reviewing → completed
模型参与状态 → failed_recoverable → 最近的正式安全状态
```

服务端状态机是唯一转换入口。非法转换返回稳定错误码并保持原状态。

## 7. 核心实体

### 7.1 Goal

- `id`
- `ownerId`
- `title`
- `category`
- `status`
- `agentState`
- `clarificationCount`
- `currentPlanVersionId`
- `desiredOutcome`
- `definitionOfDone`
- `deadline`
- `weeklyMinutes`
- `constraints`
- `motivation`
- `createdAt`
- `updatedAt`
- `version`

新建 Goal 立即以 `draft`、`agentState=intake`、`clarificationCount=0` 和空 `currentPlanVersionId` 保存。目标契约获批前，`desiredOutcome`、`definitionOfDone`、`deadline`、`weeklyMinutes`、`constraints` 和 `motivation` 可以为空；批准事务必须补齐并用完整目标 schema 重新校验。`agentState`、`clarificationCount` 和 `currentPlanVersionId` 是服务端管理字段，浏览器和模型不得直接覆盖。已取代 PlanVersion 及其 Task 保留作历史；工作台只通过 Goal 的 `currentPlanVersionId` 读取当前任务。

### 7.2 Task

- `id`
- `ownerId`
- `goalId`
- `planVersionId`
- `title`
- `action`
- `doneCriteria`
- `evidenceType`
- `estimateMinutes`
- `actualMinutes`
- `dueAt`
- `dependencyIds`
- `status`
- `createdAt`
- `updatedAt`
- `version`

### 7.3 其他实体

- `PlanVersion`：草案、批准、取代和拒绝的计划版本及差异。
- `DraftArtifact`：目标契约、计划和重规划的待审内容、规范化内容摘要与审阅状态；批准凭证必须绑定其 ID 和摘要。
- `CheckIn`：进度、阻碍、时间变化、证据和复盘反馈；阻碍使用固定六类枚举，可用时间变化保存新的每周分钟数。
- `TaskEvidence`：证据类型、文本说明或文件元数据；不保存上传文件正文。
- `AgentRun`：模型、状态、用量、工具次数、耗时和错误分类。
- `ApprovalGrant`：与 ownerId、subjectId、内容摘要和允许工具绑定的一次性批准凭证；subjectId 对应草案、被删除实体或全部清除时的固定本地 ownerId。
- `Operation`：幂等 operationId、参数摘要、执行状态和结果摘要。
- `UndoRecord`：可撤销操作的正向与反向补丁。
- `ConversationMessage`：最近用户可见消息，只允许 user 和 assistant 角色；system、tool 和隐藏推理不持久化到对话表。
- `ConversationSummary`：早期用户可见对话的压缩摘要。
- `UserPreference`：任务颗粒度、常用时间段、估时偏差、常见阻碍和有效策略。
- `AuditEvent`：批准、拒绝、工具执行、版本变化、导出和清除事件的最小审计记录。
- `AppSetting`：隐私确认时间、`mock | qwen` provider、固定模型 ID、备选开关和本地用量上限；不保存 API Key。

第一版使用固定且不可从客户端覆盖的本地 ownerId。Repository 方法仍必须显式接收 ownerId，以便测试所有权边界。

## 8. 工具权限

### 8.1 可直接读取

- `get_goal`
- `list_tasks`
- `get_progress`

### 8.2 只生成草案

- `create_goal_contract_draft`
- `create_plan_draft`
- `diagnose_blocker`
- `propose_replan`

### 8.3 明确用户意图下可执行并撤销

- `record_check_in`
- `update_task_status`
- `undo_last_change`

### 8.4 需要批准或界面二次确认

- `save_approved_contract`
- `save_approved_plan`
- `delete_task`
- `delete_goal`
- `clear_all_data`

批准凭证绑定 ownerId、subjectId、SHA-256 内容摘要、允许工具和 15 分钟有效期，只能使用一次。结构性保存绑定草案 ID；删除绑定实体 ID；全部清除绑定固定本地 ownerId。删除与清除由界面确认接口生成专用凭证，模型不能请求该凭证。

## 9. Agent 循环

每次请求的处理顺序：

1. 校验用户输入和当前目标所有权。
2. 从正式数据构建当前状态快照。
3. 只加载当前步骤相关上下文和工具。
4. 调用 Qwen。
5. 如果返回工具调用，使用 Zod 校验参数。
6. Permission Gate 判断拒绝、生成草案或允许执行。
7. 允许执行时在事务中运行工具并记录 Operation。
8. 把精简工具结果返回模型。
9. 返回用户可见回复并重新读取正式数据更新页面。

单次请求上限：4 次模型调用、3 次工具调用、1 次参数修复。相同工具名和相同参数重复出现时立即停止。每次模型调用前检查当日本地输入、输出 Token 预算；预计或已用额度达到上限时返回稳定错误并保留手动功能。

## 10. 确定性 Planning Engine

Planning Engine 提供纯函数或无模型服务：

- 计算完成率。
- 校验任务依赖环。
- 判断任务是否满足前置条件。
- 根据期限、依赖、阻塞和可用时间排列候选行动。
- 生成计划版本的结构化差异。
- 识别截止风险和估时偏差。
- 校验证据类型。

自然语言解释由模型根据这些计算结果生成；模型不能篡改计算结果。

## 11. 上下文与记忆

每次模型调用最多包含：

- 当前目标契约。
- 当前批准计划摘要。
- 与请求相关的任务。
- 最近 6 条用户可见消息。
- 一条较早对话摘要。
- 与执行有关的偏好摘要。
- 当前状态允许的工具 schema。

偏好只包括任务颗粒度、常用时间段、估时偏差、常见阻碍和有效策略。用户可以查看、修改和清除偏好。模型隐藏思维过程不进入任何记忆或日志。

## 12. 可靠性

- 工具参数校验失败时允许模型修复一次；再次失败则不执行工具。
- 模型调用 45 秒超时；只有本轮尚未提交 Goal、PlanVersion、Task、CheckIn 或证据修改时可自动重试一次，重试计入 4 次模型调用上限。提交上述领域修改后不重试。只有用户在设置中显式启用时，超时重试才可改用备选模型。
- 修改操作先创建 Operation，再使用数据库事务执行。
- 同一 operationId 重放时返回原结果。
- 写入失败时完整回滚。
- 乐观版本冲突时不覆盖数据，重新加载并要求用户审阅。
- 工具成功而回复失败时，以数据库状态为准提示操作已完成。
- AgentRun 中断后恢复到最近的正式安全状态。
- 网络或模型不可用时，手动任务管理、进度、撤销、导出和清除仍可用。新增或编辑任务结构时，由界面在本地生成计划差异草案，并继续要求用户批准后切换 PlanVersion，不调用模型。

## 13. 隐私与密钥

- `DASHSCOPE_API_KEY` 只存放于 `.env.local`。
- 浏览器端变量和响应中不得出现 Key。
- 所有修改型 HTTP 请求只接受规范本机来源 `http://127.0.0.1:3000`，拒绝缺失或不同的 Origin；CLI 评测直接调用服务层。
- `.env.local`、SQLite 数据库、导出数据、覆盖率和端到端测试产物加入 `.gitignore`。
- 首次使用明确说明必要目标内容会发送给百炼。
- 默认日志不记录完整目标正文、完整提示词、密钥或用户证据正文。
- 面向浏览器的错误只返回稳定错误码和可行动说明。
- 清除全部数据需要输入确认短语，并在事务完成后验证目标、任务、摘要、审计和设置均已删除。

## 14. 测试与评测

### 14.1 自动化测试

- 单元测试覆盖状态机、权限门、Planning Engine、计划差异、幂等和 Repository。
- 工具契约测试覆盖每个工具的合法输入、非法输入、权限拒绝和失败结果。
- API 集成测试使用独立临时 SQLite 数据库。
- React 组件测试覆盖草案、批准、差异、错误和降级状态。
- Playwright 覆盖完整创建、执行、阻碍、重规划、撤销、删除和完成流程。
- 默认模型测试使用可重复的模拟 Qwen 响应。
- 真实 Qwen 测试仅作为显式命令运行，并设置最大案例数和调用预算。
- 软件验收由代理使用隔离的合成数据执行并保存证据，不要求用户手工复测。

### 14.2 30 个评测案例

- 10 个学习目标。
- 10 个轻量工作目标。
- 5 个信息不足目标。
- 3 个不现实排期目标。
- 2 个高风险越界目标。

案例固定预期追问、禁止追问、关键里程碑、允许工具和必须确认操作。案例文件不包含个人真实隐私。

### 14.3 验收门槛

- 未批准结构性或删除操作的拦截率为 100%。
- 重放 operationId 的重复写入数为 0。
- 30 个评测案例的应用崩溃数为 0。
- 核心状态机、Permission Gate 和工具模块分支覆盖率至少 90%。
- 刷新、重启、超时和断网不丢失正式数据。
- 用户可完成撤销、导出和全部清除。
- 人工计划质量平均分至少 4/5。
- 新 Windows 环境依据 README 在 15 分钟内启动本机生产构建。

## 15. 本机运行与交付

开发命令为 `pnpm dev`。最终验收使用 `pnpm build` 和 `pnpm start`，并通过仅监听本机的地址访问。SQLite 数据文件存放在 Git 忽略的应用数据目录。

README 必须包括：

- Node.js、pnpm 和 Git 检查命令。
- 阿里云百炼开通和 API Key 创建步骤。
- `.env.local` 配置说明，但不包含真实 Key。
- 数据库初始化命令。
- 开发、测试、评测和生产启动命令。
- 常见错误的判断和恢复步骤。
- 数据导出和清除步骤。

## 16. 指导与学习要求

每个实现任务必须按照“概念解释—失败测试—最小实现—自动验证—证据记录—Git 提交”推进。每一步向用户说明：

- 为什么现在做这件事。
- 相关 Agent 概念是什么。
- Codex 将修改哪些文件。
- 用户应观察什么结果。
- 失败时先检查什么。

用户亲自完成阿里云账号、API Key 和可能产生费用的操作，且不向 Codex 发送真实密钥。

概念讲解、免费实操和自查是可选教学材料，默认保持未评定，不构成本地 MVP 完成门槛。软件验证由代理使用隔离合成数据执行；没有用户实际参与证据时，不得记录其已理解或已完成个人练习。

## 17. 完成定义

只有同时满足以下条件，本地 MVP 才算完成：

1. 所有范围内用户流程可在生产构建中完成。
2. 所有自动化测试和 30 个评测案例达到验收门槛。
3. 密钥扫描和敏感文件检查无泄漏。
4. 全新 Windows 环境按 README 验证成功。
5. 已明确记录线上邀请试用版尚未实现，并将其作为独立后续项目处理。

范围内软件流程依据代理在隔离合成数据上的验证证据判定，不依赖用户手工复测。用户个人的知识自查和亲自练习属于可选教学，不是软件完成条件；除非有用户实际证据，否则保持未评定。

## 2026-09-18 当前离线范围补充（不替代原始完成定义）

用户最新要求“没有，保留接口配置”：本轮保留 Qwen 接口与配置入口，不配置密钥、不激活真实模型。真实模型冒烟、实际模型质量和配对人工评分延期，不构成本轮离线检查点阻塞；没有把这些项目记为通过。全新 Windows 安装未验证，个人学习可选且未评定，线上邀请分享未实现。

此处此前记录的非阻塞要求缺口 M3（`record_check_in` 不可撤销）已于 2026-09-18 通过统一撤销实现关闭：最近一次任务修改恢复状态/实际分钟数，最近一次打卡或阻碍反馈标记撤销并保留历史；已撤销反馈不参与当前分析，旧建议与复盘保留历史状态。原始完成定义没有因此改写；真实模型质量、全新 Windows 安装和线上邀请版仍按各自证据判断，最新交付证据见 `docs/delivery/verification-2026-09-18.md`。
