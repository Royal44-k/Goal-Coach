> 历史设计/执行记录，保留当时决策；路径已匿名化。当前行为、默认值和发布权限以仓库当前规格及本次发布说明为准。

# Goal Coach DeepSeek 与 PWA 增量设计

日期：2026-09-24。基线：3edbb1ee04821361432c9de6573d1ab783724ecc。承接2026-09-19邀请部署规格与2026-09-24核查报告。用户已选择网页＋PWA、中国大陆首批用户，并明确委托执行方按规格自行决断、不要重复确认常规选择。本规格由执行方制定并自审，不声称用户逐字审批过本文件。保留原有子Agent驱动、测试先行及审查流程。

## 目标及范围

把现有目标闭环变为可配置DeepSeek的双端邀请试用软件：同一账号、同一服务端数据，电脑网页和手机安装态访问；模型的建议通过既有权限/工具/审批系统落地。保留现有mock和Qwen路径，不改历史模型记录、不迁移真实练习数据。先完成无需秘密或云资源的软件增量，然后进入有条件的真实模型/生产验收。

不做Flutter重写、原生应用包、支付、开放注册、社交、联网搜索、附件上传、离线AI、后台写入重放或通知推送。后续商业验证不等于本批次已上线收费。使用者通过自己的邀请码注册，运营者承担服务器与API成本。

## 全局约束

- Node.js 24.20.x、pnpm 11.19.x，沿用当前锁定依赖，不升级框架、不重装现有node_modules。
- 不读取或输出 .env.local、API Key、真实用户数据库内容；测试使用合成配置和独立临时数据库。
- 默认 MODEL_PROVIDER=mock；不进行真实模型网络请求，不购买云资源、不提交备案、不公开发布、不推送或合并分支。
- 不出现“本机 · 私密 · 可撤销”等展示样机式标语；必要的模型状态、隐私、AI告知与错误提示保留。
- 生产方案限定邀请模式、HTTPS、单个Next.js进程与持久化SQLite卷；现有身份隔离、Origin校验、统一撤销和审批边界不得放松。
- PWA不得缓存私人API、目标页面、账号信息或用户输入；不得自动补发离线写请求或自动重试付费模型请求。
- 所有通过结论须附对应环境的实测证据；桌面窄屏不等于真机，配置有效不等于真实模型可用，Next构建不等于Docker构建。

## 方案及组件

沿用Next.js/React，不另造Agent平台。DeepSeek专用适配器负责供应商协议；统一有效模型策略负责配置、模型选择、超时分支和运行日志；SettingsService负责账号策略与版本化同意；PWA层只负责安装、更新及断网告知。采用小模块，不复制整套Qwen实现、不进行无关重构。

### A. DeepSeek协议

新增server-only配置读取：DEEPSEEK_API_KEY（无默认密钥）、DEEPSEEK_BASE_URL（默认https://api.deepseek.com，仅接受官方根路径或/v1及尾斜线规范化，拒绝query/credentials/hash/第三方主机）、DEEPSEEK_MODEL（deepseek-flash默认或deepseek-v4-pro）、DEEPSEEK_MAX_OUTPUT_TOKENS（128–8192，默认2048）。选择DeepSeek但缺Key时可显示未配置状态，实际派发必须失败关闭。阻止Key通过任何NEXT_PUBLIC_同值变量暴露。

显式stream:false、thinking:{type:'disabled'}、max_tokens，不发送Qwen的enable_thinking/max_completion_tokens，不加未经验证的reasoning_effort。现有OpenAI SDK可复用，timeout=45000ms、maxRetries=0；不由SDK自行重试。DeepSeek只接受配置的一个模型，禁用Qwen回退策略。工具定义、assistant tool_calls及tool_call_id由已有ModelRequestSchema校验，输出本地严格验证。拒绝截断、内容过滤、资源中止、错误finish reason或不一致tool调用，不执行半截工具；若已返回有效usage，异常仍携带用量给现有记账器。隐藏推理与供应商扩展不进入业务日志/返回。

错误映射：401/403认证失败；402独立MODEL_BALANCE_INSUFFICIENT；400/404/422配置或模型不可用；429上游限流；连接和5xx不可用；超时MODEL_TIMEOUT；畸形输出MODEL_RESPONSE_INVALID。全部安全文案，不附上游body、cause、URL密钥、请求正文。同步AgentTurnFailureSchema，不能让这些错误退化成DATABASE_ERROR。共享协议转换/解析抽取时保持Qwen原行为和回归。

### B. 有效策略与同意

provider拓展mock|qwen|deepseek。服务端保持每个供应商独立凭据，不能因本机保存的provider与环境默认不同而拿错Key。用无秘密EffectiveModelPolicy固定一个回合的provider/primaryModel/fallbackModel/fallbackEnabled；首轮、摘要、重试、AgentRun一致。mock保留既有兼容模型标签；DeepSeek无跨模型自动fallback。真实回合发送前再次确认当前设置与同意仍匹配，防止中途撤回后继续发送。

数据库仅做加法迁移，新增privacyProvider和privacyPolicyVersion，缺失/旧同意均视为不满足新外发同意，不篡改旧时间及历史运行。告知版本使用固定常量2026-09-24；客户端同意提交所看到的provider与policyVersion，服务端拒绝不匹配的旧页面同意。Qwen告知仅阿里云，DeepSeek告知仅DeepSeek；mock不得以“已向云端发送”误导。邀请模式供应商和额度仍只读，普通用户不能改服务器策略。

公开设置不暴露Key和URL；只给当前供应商配置布尔值、有效模型和同意状态/版本。显示“未配置”或“已配置，尚未真实验证”，页面加载/保存不试连。不主动修改用户私密env；提供空白样例和私下配置说明。

### C. PWA及数据边界

manifest：name=Goal Coach、short_name=Goal Coach、lang=zh-CN、start_url=/、scope=/、display=standalone、固定id=/。提供实际可读取的192/512像素PNG图标和Apple图标，复用已有视觉标识。支持功能检测的安装按钮、iOS手动添加主屏指导、已安装态隐藏重复提示；内嵌浏览器提示使用系统浏览器，不承诺所有浏览器支持安装。

Service Worker只缓存无个人信息的离线说明页，不缓存/_next、导航响应、/api或身份内容。导航网络失败显示静态离线页；非GET、API与跨域请求不代理重放。前端在线/离线提示应说明需联网才能操作。等待中的新版只显示更新提示，用户选择更新时再切换并刷新，不在填写或提交中自动刷新；无背景同步、推送权限请求或自动付费试连。开发环境默认不注册SW以免干扰用户现有3000服务。

适配触摸、软键盘、安全区、窄屏溢出、焦点和可访问状态。新增测试不以设备UA伪装冒充真实设备。图标可通过本地确定性脚本生成，脚本与源资源入库；不借图标引入外部资源请求。public中新增真实资源同时修复Docker的缺失COPY源问题，仍须实际Linux镜像验收。

### D. 部署准备、评测与运营准入

Compose传递独立DeepSeek配置，保留mock默认；deploy check/health检验选定供应商但不联网、不回显秘密。source打包白名单包含PWA资源且不含私密配置和数据。保持管理员邀请CLI与精确Origin。

评测支持显式--provider=deepseek，默认仍mock；非mock须明确live opt-in、最大案例数，不在自动测试中读取秘密或派发真实请求。配置、运行记录和报告均注明实际provider/model，不把mock结果标成真实模型成功。

中文指南以大陆邀请试用为默认路线，列出域名/服务器/HTTPS/备案或登记适用性核对、私密配置、管理员、邀请、备份恢复、回滚、手机安装、模型账单与故障支持。引用2026-09-24核查报告中的官方来源，不填假备案号，不声称个人主体必然能经营任何业务，不认为邀请制自动豁免。

生产准入仍需：真实模型授权与预算；Linux Docker/TLS、真机、备份恢复；全站费用告警/停用流程；中断/重启后的Agent安全状态处理；隐私/服务规则和主体资料。现有单回合执行不是可恢复队列，当前应用token计数不是人民币硬封顶。上述未通过时不得宣布可收费上线；先提供明确的操作与限制清单，不在本批次引入未经设计的分布式队列/支付系统。

## 测试与交付

先红后绿：专用配置和假传输；多供应商策略/摘要/超时/日志；同意版本与撤回、旧库迁移、多账号和Origin；PWA manifest/图标/安装/离线/更新/不缓存私密数据；部署检查/打包/评测默认安全。最后lint/typecheck/全套单测/mock评测和隔离源码生产构建，浏览器使用独立端口及合成库。保留当前3000服务与练习库不动。

交付：源码提交、DeepSeek配置样例、安装与部署指南、测试报告及未完成外部准入项。完整上线交付必须另有真实HTTPS域名、管理员归属、实际设备/模型/恢复证据，不能只凭本设计宣布完成。

## 自审记录与依据

2026-09-24：检查与原邀请设计一致性、秘密隔离、默认免费、Qwen历史兼容、供应商同意切换、PWA私人缓存与更新时机、测试/云上证据边界。将用户“自行决断”记录为常规流程委托而非虚构逐项批准。当前软件增量分为协议、安全集成、PWA、交付验证四个可独立审查任务。

- 原规格：2026-09-19-invite-deployment-design.md。
- 核查报告：../../research/2026-09-24-goal-coach-review-and-roadmap.zh-CN.md。
- DeepSeek：https://api-docs.deepseek.com/api/create-chat-completion/ 、 https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/ 。
- 本地Next文档：node_modules/next/dist/docs/01-app/02-guides/environment-variables.md、progressive-web-apps.md。
