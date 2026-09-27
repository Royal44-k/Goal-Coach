> 历史设计/执行记录，保留当时决策；路径已匿名化。当前行为、默认值和发布权限以仓库当前规格及本次发布说明为准。

# 自适应目标教练 Agent 设计规格

**状态：** 已由用户于 2026-09-02 分段批准

**项目目录：** `C:\Projects\Goal-Coach`

**当前项目：** 个人目标拆解与任务管理 Agent

**明确排除：** 外贸单证核验 Agent。本规格不复用、不扩展也不实现该项目。

## 1. 产品目标

构建一款面向个人学习目标和轻量工作目标的自适应目标教练 Agent。它不止生成任务清单，还会与用户协商目标契约、给出当前最佳行动、识别执行阻碍、提出重规划草案，并在所有结构性修改前获得人工批准。

第一里程碑是仅供用户本人在 Windows 电脑上运行的本地 Web 应用。第二里程碑是在第一里程碑全部验收后，部署一个仅限 3～5 位朋友通过邀请码访问的线上试用版。

成功不是“模型能聊天”，而是用户可以可靠地完成以下闭环：

1. 输入目标。
2. 补充必要信息。
3. 审阅目标契约。
4. 审阅任务计划。
5. 明确批准保存。
6. 执行当前最佳行动。
7. 记录进展或阻碍。
8. 审阅并批准必要的重规划。
9. 提交约定形式的完成证据。
10. 完成目标复盘。

## 2. 用户与范围

### 2.1 第一里程碑用户

- 单个本地用户。
- 使用中文界面。
- 通过浏览器访问本机 Next.js 服务。
- 不需要注册、登录或公开端口。
- 可以保存多个目标，但一次会话只围绕一个当前目标工作。

### 2.2 支持的目标

- 学习目标，例如学习 TypeScript、完成课程或制作作品集。
- 轻量工作目标，例如准备汇报、整理方案或完成小型交付物。

### 2.3 不支持的目标和能力

- 医疗、法律、投资等高风险决策目标。
- 违法、有害或规避安全限制的目标。
- 联网搜索和外部资料检索。
- 日历、邮件、即时通信和第三方任务平台集成。
- 自动替用户发送消息、购买商品或执行真实业务操作。
- RAG、向量数据库、模型微调和多 Agent。
- 复杂资源优化、团队协作、公开注册和付费。
- 任意代码执行、终端命令执行和直接数据库访问。

## 3. 设计原则

1. **模型负责语义，代码负责事实。** Qwen 负责理解目标、生成建议和选择工具；确定性代码负责权限、状态转换、进度、日期、依赖、差异和持久化。
2. **草案不等于事实。** 目标契约、计划和重规划在用户批准前都是草案，不能覆盖正式数据。
3. **人工确认不可伪造。** 模型不能生成批准凭证，也不能把普通肯定语句自行解释成结构性写入授权。
4. **可恢复优先。** 写入具有幂等编号，结构性修改保留版本，可撤销操作记录反向补丁。
5. **上下文最小化。** 每次只向模型发送完成当前步骤所需的目标、计划、相关任务、近期对话和偏好摘要。
6. **本地功能可降级。** 模型或网络不可用时，用户仍能管理已保存任务和导出数据。
7. **先掌握原理。** Agent 循环由项目代码显式实现，不采用 LangChain、LangGraph、Dify 或 Coze 隐藏核心流程。

## 4. 产品行为

### 4.1 目标澄清

Agent 检查以下字段：

- 期望成果。
- 完成定义。
- 截止日期。
- 每周可投入时间。
- 已知限制。
- 用户做这件事的主要动机。

每轮最多询问一个问题，并解释为什么需要该信息。最多主动澄清三轮。三轮后仍缺少非关键字段时，Agent 明确列出默认假设并允许用户继续；缺少期望成果或完成定义时不得生成可批准计划。

### 4.2 目标契约

目标契约包含：

- 要完成的成果。
- 完成状态的可观察定义。
- 截止日期和时间预算。
- 关键限制。
- 明确不做的事项。
- 计划失效时的处理方式。

契约先进入 `contract_review` 状态。用户可以通过界面编辑或要求 Agent 修改。用户点击批准后，服务端创建一次性批准记录，正式契约才会写入。

### 4.3 计划草案

计划包含里程碑和当前规划窗口内的 3～8 个任务。每个任务包含：

- 标题。
- 具体行动。
- 预计耗时。
- 建议截止时间。
- 前置任务。
- 完成标准。
- 可接受的完成证据类型。

当一个任务预计超过 60 分钟时，Agent 必须同时提供一个 5～30 分钟的当前最佳行动，但不擅自改变正式任务。

### 4.4 执行教练

计划激活后，首页突出一个当前最佳行动。选择规则依次考虑：

1. 前置条件是否满足。
2. 截止风险。
3. 用户本次可用时间。
4. 是否存在阻塞。
5. 当前里程碑优先级。

模型可以用自然语言解释推荐理由；实际排序输入由 Planning Engine 计算。

用户可以通过任务面板或明确的自然语言指令查看任务、修改任务、标记完成、撤销最近修改以及删除任务。修改状态属于可撤销更新；删除任务必须经过界面二次确认，并保留审计记录。

### 4.5 阻碍诊断

用户点击“我卡住了”或用自然语言表达阻碍时，Agent 将原因归为以下一种或多种：

- 不知道如何开始。
- 任务颗粒度过大。
- 可用时间不足。
- 缺少资料或外部条件。
- 担心做错。
- 前置任务尚未完成。

Agent 可以生成拆小、排期、等待或替代路径草案。涉及正式任务结构或期限的变化必须进入 `plan_review`，不得直接执行。

### 4.6 自适应重规划

以下事件可以触发重规划建议：

- 实际耗时显著高于估计。
- 同一任务连续两次被跳过。
- 截止日期风险升高。
- 用户可投入时间发生变化。
- 前置任务失败或外部条件未满足。

重规划界面必须展示新增、删除、移动和修改的任务，说明变化原因，并标注来源是用户要求还是 Agent 建议。旧计划保持有效，直到用户批准新版本。

### 4.7 完成证据和复盘

任务可接受的证据类型为：文本说明、文件元数据、检查问题答案或用户声明。第一里程碑不读取文件正文，也不由模型判断证据真伪；系统只验证证据形式是否符合任务预先约定。

目标完成前，Agent 汇总计划变更、预计与实际耗时、主要阻碍和有效策略。用户确认复盘后，目标进入 `completed`。

## 5. Agent 状态机

### 5.1 状态

- `intake`：接收新目标。
- `clarifying`：逐项补充必要信息。
- `contract_review`：等待目标契约批准。
- `planning`：生成计划草案。
- `plan_review`：等待新计划或重规划批准。
- `active`：计划正在执行。
- `reviewing`：记录进展、阻碍或完成证据。
- `replanning`：生成计划差异草案。
- `paused`：用户主动暂停。
- `completed`：完成复盘并关闭目标。
- `failed_recoverable`：本次 Agent 运行失败，但正式数据保持一致。

### 5.2 允许的主要转换

```text
intake → clarifying → contract_review → planning → plan_review → active
intake → contract_review（输入已包含全部关键字段时）
clarifying → clarifying（仍需追问且未达到三轮上限时）
active → reviewing → active
active → replanning → plan_review → active
active ↔ paused
active → reviewing → completed
任意模型参与状态 → failed_recoverable → 原安全状态
```

状态转换由服务端代码验证。模型只提出下一步建议，不能直接设置状态。

## 6. 系统架构

```text
Next.js Web UI
      ↓
Server Route Handlers
      ↓
Agent Orchestrator / State Machine
      ├── Prompt Builder
      ├── Qwen Client
      ├── Tool Registry
      └── Permission Gate
              ↓
Planning Engine / Domain Services
              ↓
Repository + Audit Logger
              ↓
SQLite（本机）/ PostgreSQL（邀请试用）
```

### 6.1 技术栈

- Node.js 24.20.0 LTS。
- pnpm 11.19.0。
- Next.js 16 或更高的同一主版本稳定版，App Router，Node.js Runtime。
- React、TypeScript 严格模式；TypeScript 7 CLI 与 TypeScript 6 compatibility API 按官方方案并行安装，供尚未支持 TypeScript 7 API 的 ESLint 工具使用。
- Zod 进行所有外部输入、模型参数和工具返回值校验。
- Drizzle ORM；本机适配 SQLite，线上适配 PostgreSQL。
- 百炼 OpenAI 兼容 Chat Completions API。
- 主模型固定为 `qwen3.7-flash-2026-07-15`。
- 备选模型为 `qwen3.7-plus-2026-05-26`，默认关闭，只有配置明确启用后才可使用。
- Vitest、React Testing Library、Playwright。

### 6.2 组件职责

| 组件 | 职责 | 明确不负责 |
|---|---|---|
| Web UI | 展示对话、草案、批准操作、任务和进度 | 不接触 API Key，不决定权限 |
| Route Handlers | HTTP 输入输出、会话、流式响应 | 不包含业务决策 |
| Agent Orchestrator | 控制状态、模型调用和工具循环 | 不直接读写数据库 |
| Prompt Builder | 组装最小上下文和允许工具 | 不保存历史 |
| Qwen Client | API 协议、超时、重试和用量 | 不决定业务权限 |
| Tool Registry | 工具 schema 和执行入口 | 不绕过 Permission Gate |
| Permission Gate | 按状态、意图和批准凭证授权 | 不生成批准凭证 |
| Planning Engine | 进度、风险、依赖、排序和差异 | 不生成自然语言建议 |
| Repository | 数据持久化和事务 | 不接受未经校验的模型参数 |
| Audit Logger | 记录工具运行、批准和版本变化 | 不记录模型隐藏思维过程 |

## 7. 核心数据模型

所有实体使用不可预测的字符串 ID，并包含 `createdAt`、`updatedAt` 和整数 `version`。

### 7.1 Goal

- `id`
- `ownerId`
- `title`
- `category: learning | light_work`
- `status: draft | active | paused | completed | archived`
- `agentState`
- `clarificationCount`
- `currentPlanVersionId`
- `desiredOutcome`
- `definitionOfDone`
- `deadline`
- `weeklyMinutes`
- `constraints`
- `motivation`

新建 Goal 先以 `draft` 保存原始标题、分类、`agentState=intake` 和 `clarificationCount=0`。在目标契约获批前，`desiredOutcome`、`definitionOfDone`、`deadline`、`weeklyMinutes`、`constraints` 和 `motivation` 可以为空；契约批准事务必须补齐并重新校验这些字段。`agentState`、`clarificationCount` 和 `currentPlanVersionId` 只能由服务端状态机或批准事务修改。已取代计划及其任务保留为历史数据，工作台只通过 `currentPlanVersionId` 读取当前任务。

本机版使用固定本地 `ownerId`；线上版使用邀请账户 ID。Repository 的所有查询从第一天起都要求传入 `ownerId`。

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
- `status: todo | doing | blocked | done | skipped`

### 7.3 PlanVersion

- `id`
- `ownerId`
- `goalId`
- `number`
- `status: draft | approved | superseded | rejected`
- `changeReason`
- `changeSource: user | agent`
- `diff`
- `approvedAt`

### 7.4 CheckIn

- `id`
- `ownerId`
- `goalId`
- `taskId`
- `kind: progress | blocker | availability_change | evidence | reflection`
- `blockerCategory: cannot_start | task_too_large | insufficient_time | missing_resource | fear_of_error | prerequisite_incomplete | null`
- `note: string | null`
- `minutesSpent: number | null`
- `availableWeeklyMinutes: number | null`

### 7.5 AgentRun

- `id`
- `ownerId`
- `goalId`
- `startState`
- `endState`
- `status: running | succeeded | failed`
- `model`
- `inputTokenCount`
- `outputTokenCount`
- `toolCallCount`
- `latencyMs`
- `errorCode`

### 7.6 ApprovalGrant 与 Operation

`ApprovalGrant` 绑定 `ownerId`、`subjectId`、规范化内容摘要、允许的工具、15 分钟过期时间和使用时间。结构性保存的 subjectId 是 DraftArtifact ID；删除的 subjectId 是目标实体 ID；全部清除使用固定本地 ownerId。它只能由用户点击明确批准或二次确认按钮后由服务端生成。

`Operation` 记录唯一 `operationId`、工具名、参数摘要、执行状态和结果摘要。同一 `operationId` 再次到达时返回原结果，不重复执行。

### 7.7 支撑实体

- `DraftArtifact`：保存目标契约、计划和重规划的待审内容及其规范化摘要。
- `TaskEvidence`：保存证据类型、文本说明或文件元数据，不保存上传文件正文。
- `ConversationMessage` 与 `ConversationSummary`：分别保存近期 `user | assistant` 可见消息和较早对话摘要；system、tool 和隐藏推理不持久化到对话表。
- `UserPreference`：保存与任务执行有关的低敏感偏好。
- `AuditEvent`：保存批准、工具、版本、导出和清除的最小审计事件。
- `AppSetting`：保存隐私确认、`mock | qwen` provider、固定模型 ID、备选开关和用量上限，不保存 API Key。

## 8. 工具与权限

### 8.1 只读工具

- `get_goal`
- `list_tasks`
- `get_progress`

允许在相关目标上下文中直接调用。

### 8.2 草案工具

- `create_goal_contract_draft`
- `create_plan_draft`
- `diagnose_blocker`
- `propose_replan`

可以生成草案或诊断，但不能修改正式计划。

### 8.3 可撤销更新工具

- `record_check_in`
- `update_task_status`
- `undo_last_change`

仅当用户在当前消息中明确要求相应更新时可直接执行。Agent 自主建议必须先以草案展示。

### 8.4 结构性和破坏性工具

- `save_approved_contract`
- `save_approved_plan`
- `delete_task`
- `delete_goal`

保存工具要求一次性 `ApprovalGrant`。删除工具只能由界面二次确认触发，模型不能调用删除批准接口。

## 9. 模型调用与上下文

每次模型调用最多携带：

- 当前目标契约。
- 当前批准计划摘要。
- 当前步骤相关的任务。
- 最近 6 条用户可见消息。
- 较早对话摘要。
- 与任务执行相关的用户偏好摘要。
- 当前状态允许的工具定义。

单次用户请求最多 4 次模型调用、3 次工具调用和 1 次结构化参数修复。重复出现相同工具名和相同参数时立即停止循环。每次模型调用前执行当日本地 Token 预算检查；额度不足时返回稳定错误并保留手动功能。

系统不存储或展示模型隐藏思维过程。日志保存用户可见输出、工具参数摘要、工具结果摘要和错误分类。

## 10. 可靠性与错误恢复

| 情况 | 处理方式 |
|---|---|
| 工具参数不符合 Zod schema | 返回字段错误让模型修复一次 |
| 修复后仍无效 | 不执行工具，进入 `failed_recoverable` |
| 百炼请求超时 | 仅在本轮尚未提交 Goal、PlanVersion、Task、CheckIn 或证据修改时自动重试一次；重试计入 4 次调用上限；备选模型须由用户显式启用 |
| 修改请求结果未知 | 使用 `operationId` 查询结果，不盲目重试 |
| 工具成功但最终回复失败 | 从数据库加载真实状态并提示操作已完成 |
| 数据库写入失败 | 完整事务回滚 |
| 上下文过长 | 保留正式数据，压缩早期对话摘要 |
| 网络不可用 | 禁用模型功能，保留本地任务管理 |
| 应用重启 | 根据未完成 AgentRun 和正式数据恢复到原安全状态 |

数据库写入使用事务和乐观版本检查。版本冲突时不覆盖数据，而是刷新页面并要求重新审阅草案。

## 11. 隐私与安全

### 11.1 本机版

- 百炼 API Key 仅存放在服务端 `.env.local`，环境变量名为 `DASHSCOPE_API_KEY`。
- 任何 `NEXT_PUBLIC_` 变量不得包含密钥或访问令牌。
- `.env.local`、本地数据库、导出文件和测试报告不提交 Git。
- 首次使用时说明：目标文本和必要上下文会发送至百炼。
- 默认日志不记录完整目标正文、完整提示词或密钥。
- 错误响应不返回内部路径、堆栈和环境变量。
- 用户可以导出和清除全部本地数据。

### 11.2 邀请试用版

- 邀请码仅存储安全散列，并且每个邀请码只能兑换一次。
- 兑换后使用 `HttpOnly`、`Secure`、`SameSite=Lax` 的签名会话 Cookie。
- 所有 Repository 操作强制包含 `ownerId`。
- 同时实施账号级和 IP 级限流、每日 Token 预算和单请求循环上限。
- 普通管理页面不提供查看用户目标正文的入口。
- 数据库每日备份，恢复流程在开放邀请前演练一次。

## 12. 降级能力

当 Qwen 或网络不可用时，以下功能仍可工作：

- 查看目标和任务。
- 手工创建、编辑任务。
- 标记任务完成。
- 查看确定性进度。
- 撤销最近一次可撤销操作。
- 导出或清除数据。

手工新增或编辑任务结构时，界面在本地生成带差异的 PlanVersion 草案，仍需用户批准后切换当前版本，不依赖模型。

目标澄清、智能拆解、阻碍诊断和重规划建议会显示不可用状态，不伪装为成功。

## 13. 测试与评测

### 13.1 自动化测试

- 单元测试：状态机、权限门、Planning Engine、计划差异、幂等和 Repository。
- 工具契约测试：每个工具的输入、输出、权限和错误行为。
- API 集成测试：使用测试数据库验证事务、批准凭证和 Agent 循环。
- React 组件测试：草案、差异、错误和降级状态。
- Playwright 端到端测试：创建目标、批准、执行、阻碍、重规划、撤销和完成。
- 模型契约测试：大多数测试使用固定模拟响应，发布前才运行真实 Qwen 冒烟测试。

核心状态机、权限门和工具模块的分支覆盖率不得低于 90%。覆盖率不是唯一门槛，所有高风险拒绝路径必须有明确测试。

### 13.2 初始评测集

建立 30 个匿名合成案例：

- 10 个学习目标。
- 10 个轻量工作目标。
- 5 个信息明显不足的目标。
- 3 个时间安排不现实的目标。
- 2 个超出范围的高风险目标。

每个案例定义预期追问、禁止追问、关键里程碑、允许工具和必须确认的操作。真实问题先加入评测集，再修改提示词或代码。

### 13.3 本机版验收

- 未批准时结构性和删除操作拦截率 100%。
- 相同 `operationId` 重放时重复写入数为 0。
- 30 个评测案例不出现应用崩溃。
- 模型非法参数不能绕过 schema 和 Permission Gate。
- 刷新、重启和网络中断不丢失正式数据。
- 用户能够撤销、导出和清除数据。
- 新 Windows 环境依据 README 在 15 分钟内启动。
- 人工按准确性、可执行性、时间合理性、可验证性和限制遵循度评分，平均至少 4/5。

### 13.4 邀请试用版验收

- 3～5 位朋友每人创建至少 3 个目标。
- 至少 80% 的目标完成“澄清—契约—计划批准”。
- 至少 60% 的用户在 3 天内再次访问。
- 至少 70% 的当前最佳行动被评价为清楚可执行。
- 数据串用、重复写入和越权事件均为 0。
- 每名用户可以查看并删除自己的全部数据。
- 调用预算触顶后停止模型调用，本地任务操作仍正常。

## 14. 部署设计

### 14.1 第一里程碑：本机

开发运行使用 `pnpm dev`。验收必须使用 `pnpm build` 和 `pnpm start` 的生产构建。本机数据库为 SQLite，服务只监听本机接口，不通过路由器或隧道公开。

### 14.2 第二里程碑：邀请码试用

```text
域名与 HTTPS
      ↓
Caddy 反向代理
      ↓
Next.js standalone Docker 容器
      ↓
PostgreSQL
      ↓
百炼 Qwen API
```

部署目标为阿里云中国香港节点上的单实例环境。使用 Docker Compose 固定应用、Caddy 和 PostgreSQL 的版本。密钥通过服务器环境变量注入；PostgreSQL 使用持久卷和每日备份；应用提供健康检查并保留上一版本镜像用于回滚。

香港或海外节点无需工信部 ICP 备案，但在对中国内地用户开放前必须依据当时适用规则核查公安联网备案等义务。试用版先仅向项目所有者开放，完成冒烟测试和恢复演练后再逐个发放邀请码。

## 15. 指导式开发流程

每个开发任务遵循相同教学循环：

1. 解释本步解决的问题和对应 Agent 知识。
2. 明确将创建或修改的文件。
3. 先写一个会失败的测试。
4. 运行测试并观察预期失败。
5. 编写最小实现使测试通过。
6. 运行相关测试、类型检查和代码检查。
7. 用户在本机执行一次关键操作。
8. 解释代码如何工作以及常见错误。
9. 创建一个范围清晰的 Git 提交。

用户无需把 API Key 发给 Codex。涉及阿里云账号、密钥、域名和付款的步骤由用户在自己的浏览器中执行，Codex提供逐项指导和验证方法。

## 16. 学习知识清单

### 16.1 第一里程碑必须掌握

- Agent 与普通聊天机器人的区别。
- System、User、Assistant 和 Tool 消息。
- Chat Completions 与 Function Calling 的交互循环。
- JSON Schema、Zod 和不可信模型输出验证。
- 显式状态机和允许的状态转换。
- 工具注册、工具权限和人工确认。
- 上下文选择、摘要和 Token 使用。
- SQLite、事务、幂等和乐观版本控制。
- API Key、服务端环境变量和浏览器安全边界。
- 单元测试、集成测试、端到端测试和模型评测的区别。
- Git 提交、差异检查和安全回退。

### 16.2 第二里程碑增加

- 邀请码、会话 Cookie 和用户数据隔离。
- PostgreSQL 和数据库迁移。
- Docker、Docker Compose 和持久卷。
- HTTPS、反向代理、健康检查和日志。
- 限流、Token 预算、备份和回滚。
- 小规模试用指标和反馈分析。

### 16.3 当前不学习

- 多 Agent 编排。
- 向量检索与知识库。
- 模型微调。
- Kubernetes 和多实例扩缩容。
- 复杂可观测性平台。
- 支付和商业化系统。

## 17. 交付顺序

1. 初始化项目和开发环境。
2. 建立核心类型、状态机和测试设施。
3. 实现权限门、批准凭证和幂等操作。
4. 实现 SQLite Repository 和工具层。
5. 使用模拟模型完成 Agent 循环。
6. 接入真实 Qwen。
7. 实现目标契约和计划审批界面。
8. 实现执行、阻碍诊断、重规划和撤销。
9. 完成 30 个案例评测和本机生产构建。
10. 增加邀请账户、PostgreSQL 和用量控制。
11. 部署中国香港试用环境并完成恢复演练。
12. 开展 3～5 人试用并按验收指标评估。

## 18. 已确认决策

- 项目类型：个人目标拆解与任务管理 Agent。
- 产品定位：执行教练为主，融合风险管理和轻量个性化。
- 运行形态：先本地 Web，后邀请码线上试用。
- 模型平台：阿里云百炼 Qwen。
- 保存规则：先预览，用户批准后保存。
- 第一版用户：本机单用户。
- 目标范围：学习目标和轻量工作目标。
- 应用架构：Next.js 全栈、自定义 Agent 循环。
- Agent 控制：显式状态机、确定性权限门、工具调用上限。
- 本地数据：SQLite。
- 试用数据：PostgreSQL、按用户隔离。
- 部署：阿里云中国香港节点、Docker Compose、HTTPS。

## 19. 参考资料

- 阿里云百炼 Function Calling：<https://help.aliyun.com/zh/model-studio/qwen-function-calling>
- 阿里云百炼 API Key：<https://help.aliyun.com/zh/model-studio/get-api-key>
- 百炼文本生成 API：<https://help.aliyun.com/zh/model-studio/qwen-api-reference>
- Next.js 部署：<https://nextjs.org/docs/app/getting-started/deploying>
- Next.js 自托管：<https://nextjs.org/docs/app/guides/self-hosting>
- 阿里云 ICP 备案流程：<https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview>
