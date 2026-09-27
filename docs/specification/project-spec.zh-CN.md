# Goal Coach 0.2.2 项目规格与 Agent 设计

状态：当前实现说明，基于2026-09-27源码与验收整理。历史文件保留原日期；当前默认值和行为以本文件及源码为准。并非另行扩展开发范围的需求单。

## 1. 产品定位与成功标准

面向个人学习和轻工作目标，帮助用户把模糊意图变成今天能开始的行动，并通过反馈重排。目标不是替用户完成学习或真实业务，而是建立“明确成果—可信计划—执行证据—修正—复盘”的闭环。

两种运行方式：

| 模式 | 身份、数据与使用方式 |
| --- | --- |
| local | 单用户，本机Node服务与SQLite，只监听回环地址；无需注册 |
| invite | 运营者单实例服务器，邀请码注册，按认证账号隔离；运营者承担模型账单 |

Web和手机PWA使用同一动态后端。首批定位是少量朋友邀请试用，不是已证明商业可收费的成熟SaaS。

验收应分别衡量：功能能完成、建议符合时间/成果、用户是否真正开始并完成、调用成本与失败率。当前自动化记录只证明前两者的部分合成场景；留存、真实效率、营收尚无实测结论。

## 2. 已实现的功能契约

| 编号 | 功能 | 关键规则与验收点 |
| --- | --- | --- |
| F01 | 目标输入与澄清 | 学习/轻工作；成果、完成标准、期限、每周分钟、限制、动机；最多三轮主动澄清 |
| F02 | 目标契约草案 | 默认假设显式记录；正式状态在可信界面批准前不变 |
| F03 | 初次计划 | 3–8项任务与里程碑；每项有action、doneCriteria、estimateMinutes、dependencyIds、dueAt、evidenceType |
| F04 | 当前行动与执行 | 依赖、状态与进度由代码计算；支持开始、完成、实际耗时和证据 |
| F05 | 反馈与阻碍 | 记录进展/阻碍/容量变化；建议不直接改正式计划 |
| F06 | 重规划 | 草案比较、拒绝、批准；保留完成含义与证据，版本过期拒绝 |
| F07 | 统一撤销 | 撤销最近支持的任务变化或反馈；反馈撤回留历史但不再参与当前分析 |
| F08 | 复盘与完成 | 保存复盘；用户明确完成目标，不凭聊天自行宣告用户工作完成 |
| F09 | 数据控制 | JSON导出和明确确认后的账号业务数据清除；导出包含历史，需私密保存 |
| F10 | 邀请账号 | 管理员bootstrap、成员邀请码、撤销邀请、禁用账号、登录退出和会话失效 |
| F11 | 模型控制 | mock/Qwen/DeepSeek，服务端Key、按供应商与告知版本同意、撤回及配额 |
| F12 | PWA | manifest/图标/安装提示/受控更新；只缓存公开离线说明，不缓存私人业务 |

非目标：支付、公开注册、多人协作编辑、原生Flutter应用、邮件/日历、联网搜索、RAG、向量库、多Agent应用运行时、自动浏览器/终端操作、后台定时自动执行。开发期间使用子Agent审查不代表产品采用多Agent架构。

## 3. 架构与责任

```text
浏览器/PWA
  └─ Next页面 + HTTP API
       ├─ 身份/Origin/请求校验
       ├─ 业务Service → Repository/事务 → SQLite
       └─ Agent编排器
            ├─ 可信当前上下文 + 有限工具清单
            ├─ 有效模型策略/同意/预算 → DeepSeek或Qwen
            └─ 参数/权限/版本校验 → 受限工具 → 草案或可撤销操作
服务器入口：Caddy HTTPS → 单个Node进程；SQLite在持久卷
```

模型负责理解和提出内容；代码负责身份、权威事实、状态、版本、数值、审批和持久化。没有把模型输出直接作为数据库命令。历史聊天不覆盖服务器已批准状态；用户输入、反馈备注和任务文字始终视为不可信数据。

技术栈由 package.json 与 pnpm-lock.yaml 固定：Node24.20.x、pnpm11.19.x、Next16.3.4、React19.2.8、TypeScript、Zod、Drizzle、better-sqlite3。运行入口不依赖LangChain/LangGraph平台。

## 4. 状态与审批

Goal.status：draft、active、paused、completed、archived。

Agent.state：intake、clarifying、contract_review、planning、plan_review、active、reviewing、replanning、paused、completed、failed_recoverable。Goal.status和Agent.state含义不同，例如契约已批准而初次计划尚未批准时，Goal仍可为draft。

典型序列：

```text
intake/clarifying → contract_review → 人工批准 → planning
  → plan_review → 人工批准 → active
  → 执行/反馈 → 重排草案/plan_review → 人工批准 → active
  → reviewing → 复盘保存 + 用户确认 → completed
```

该图是概念路径，不意味着所有状态可任意互跳；实际转换由状态机与服务校验。目标暂停、删除、清除和手动计划修改都须经过对应可信入口。

## 5. Agent工具与调用预算

| 权限层 | 工具 | 边界 |
| --- | --- | --- |
| read | get_goal、list_tasks、get_progress | 注册表存在；已有统一快照时不重复向模型提供同类读工具 |
| draft | create_goal_contract_draft、create_plan_draft、diagnose_blocker、propose_replan | 只保存草案/建议，不能批准 |
| reversible | record_check_in、update_task_status、undo_last_change | 要求明确意图、适用状态及操作编号，可撤销 |
| structural | save_approved_contract、save_approved_plan | 仅可信批准路径，模型不能调用 |
| destructive | delete_task、delete_goal、clear_all_data | 对应界面确认路径，模型不能调用 |

单回合最多3次工具尝试、4次模型调用，共享一次参数/响应修复预算；SDK不自动重试。DeepSeek不自动切换到别的模型；Qwen保留其独立且默认关闭的回退配置。发生结果未知时使用同operationId恢复，不创建新请求盲目重试。

上下文包含当前目标/任务/进度、最近有效反馈、少量对话与偏好摘要。反馈最多近期10条、备注最多1000个Unicode字符；关联标题从当前有效taskId映射，不把已撤回/重置/移除的历史关联重新猜回去。

## 6. 计划与可靠性护栏

- 模型仅提交严格的任务提案字段；服务端根据可信基准生成差异与执行重置元数据。
- 调用方基准版本仍须匹配；事务落库前重新校验，不通过刷新版本替模型遮蔽并发变化。
- 已完成任务的ID、行动、完成标准、证据类型与依赖含义保留；不能靠口头解释代替保留。
- 未完成/新任务日期不能超出批准期限。
- 相同工作的估时不允许自动下降；即使合并或改写，模型重排未完成总估时不能低于当前可信总量。真实提效可经用户手动审阅调整，不由模型自行打折。
- 容量依据可信当前时间、上海时区期限日结束及最新有效每周时间推算；保留done/skipped不算未来工作，也不重复扣历史实际分钟。
- 明确请求重排且当前估时冲突、整回合无工具时，可返回确定性的容量提示。文字识别有限，不能视为通用意图分类器或通用推演泄露过滤器。
- 草案保存回执由服务器按实际落库任务数量与总分钟生成，避免自由概述算错或虚称已保存。
- 同一请求幂等重放不重复模型派发；所有权、作用域、版本与fence防止跨账号及旧请求覆盖。
- 模型异常后的任务手动操作、导出等尽量可用；不承诺跨进程崩溃后自动续跑整个Agent回合。

这些是保守正确性规则，不是对真实工作量、语义完整性或用户成功的数学证明。

## 7. 数据与证据

| 数据组 | 主要实体 | 意义 |
| --- | --- | --- |
| 目标规划 | goals、plan_versions、tasks、draft_artifacts | 正式目标、版本化计划与未生效草案 |
| 执行 | check_ins、task_evidence、undo_records | 进展/阻碍/容量、证据、撤销历史 |
| 运行安全 | agent_runs、approval_grants、operations、audit_events | 调用计量、批准、幂等、审计 |
| 对话偏好 | conversation_messages、conversation_summaries、user_preferences、app_settings | 有限上下文、设置与同意 |
| 账号 | auth_users、auth_invites、auth_sessions、auth_throttles | 邀请登录、会话与节流 |

证据类型为text、file_metadata、check_answer、user_declaration。file_metadata只记录文件名/大小/MIME，**不上传文件内容，也不证明模型读过文件**；用户声明也不是第三方核验。任务完成和目标交付的真实性最终由用户负责。

数据导出schemaVersion=2，包含历史反馈和撤回标记，不等同于模型每轮看到的有效上下文。SQLite迁移、在线backup与恢复到新路径是运维边界；不把普通复制正在写入的.db视为可靠备份。

## 8. HTTP与服务边界

主要路由：/api/goals、/api/goals/[goalId]、/api/agent/turn、/api/approvals、任务/反馈/undo子路由、/api/settings、/api/export、/api/data/clear、/api/auth/*、/api/admin/*、/api/health。具体请求字段以 src/lib/public-api-schemas.ts 和路由实现为准。

私有接口按会话身份确定ownerId，拒绝浏览器伪造ownerId；写入检查Origin与请求schema。内部health只检查配置与数据库，不调模型，Caddy不向公网暴露它。公开设置只返回配置布尔值、模型策略及同意状态，绝不返回Key。

## 9. 模型配置、安全与费用

默认mock；DeepSeek项目支持https://api.deepseek.com、deepseek-flash/备选deepseek-v4-pro，输出上限默认4096（128–8192），超时45秒。Qwen独立凭据与预算，不能混用Key。模型可用性及供应商价格以部署时官方平台为准，本文不锁定费用。

默认每账号每日输入100000、输出30000 token、邀请模式每天50回合；并发保护依赖单Node进程，不能直接水平扩容。Token限额不是人民币硬封顶；另需供应商余额、告警、运营停用流程。用户有供应商/版本匹配的同意后才派发，撤回阻止后续派发，已发送内容无法收回。

## 10. 部署与验收准入

单机local只监听127.0.0.1；服务器必须invite + 唯一HTTPS APP_ORIGIN，Caddy公开80/443，应用3000只在Docker网络可见。固定Node/pnpm/Caddy镜像版本，不用latest规避问题。SQLite与证书持久卷；app以UID/GID1000运行，禁止改成root或chmod777掩盖权限问题。

验收记录：1172项代码、16项浏览器、生产构建及重启/备份/恢复通过；两类真实DeepSeek合成流程通过，人工时间选择和非阻断措辞残留已披露。新整理版应保持应用源码hash一致。

尚未验收：Linux容器实构建、阿里云香港主机、DNS/HTTPS、真机PWA、生产访问性能、真实用户效果。已知开发工具链有一项moderate公告，见 [SECURITY.md](../../SECURITY.md)。全部外部准入通过前，不得将“公开仓库可下载”宣传为“已上线可收费”。
