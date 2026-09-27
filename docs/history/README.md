# 项目决策沿革

这是从现存项目文件和交付证据整理的时间线，不是完整聊天转录。最初“哪些 Agent 领域市场紧缺”的独立调研原稿未在可恢复项目资产中找到；本仓库不补造市场规模、用户访谈或商业验证结果。当前定位仍需真实试用验证。

| 时间 | 主要决策与资产 |
| --- | --- |
| 2026-09-02 | 选择自适应目标教练，融合目标澄清、计划、行动反馈与重排；[整体设计](../superpowers/specs/2026-09-02-adaptive-goal-coach-design.md)、[首版本地规格](../superpowers/specs/2026-09-02-local-goal-coach-mvp-design.md) |
| 2026-09-04 起 | 按批准规格进行子 Agent 驱动实现与测试；[MVP 实施计划](../superpowers/plans/2026-09-04-local-goal-coach-mvp.md) |
| 2026-09-18 | 保留模型接口、先熟悉免费流程，采用统一撤销；[撤销交付设计](../superpowers/specs/2026-09-18-unified-undo-delivery-design.md)、[Qwen 接入评估](../research/2026-09-18-qwen-readiness.md) |
| 2026-09-19 | 从本机单人版扩展至邀请制少量朋友试用，加入认证、账号隔离、Docker/Caddy；[邀请部署设计](../superpowers/specs/2026-09-19-invite-deployment-design.md) |
| 2026-09-24 | 主接入改为 DeepSeek，保留 Qwen；交付选择网页＋手机 PWA，不改写 Flutter；[DeepSeek/PWA 设计](../superpowers/specs/2026-09-24-deepseek-pwa-design.md)、[重审路线](../research/2026-09-24-goal-coach-review-and-roadmap.zh-CN.md) |
| 2026-09-24–27 | 合成数据真实模型验收、协议与计划完整性修正、邀请/浏览器/备份恢复验收；[全量记录](../delivery/full-acceptance-2026-09-27.md) |
| 2026-09-27 | 以已核验 0.2.2 源码包为基线整理公开仓库，补齐可移植指南、规格、脱敏案例和资产目录 |

## 如何使用历史文件

`docs/superpowers/specs/` 保存 5 份设计，`docs/superpowers/plans/` 保存 5 份开发/验收计划。它们能解释“为什么这样做”，不是让你重新执行所有步骤。

历史文本中的本机路径已匿名化，旧的 2048 输出设置、旧提供方选择、旧版本和阶段性权限约束反映当时状态。**当前行为以[项目规格](../specification/project-spec.zh-CN.md)、当前代码和[启动指南](../guides/quickstart.zh-CN.md)为准**；不要照抄历史路径、旧密钥配置或开发助手缓存工具路径。

本仓库从整理后的干净快照开始提交，不复制原开发 Git 历史、私人环境文件或完整对话。历史文件保留当时失败和不足，不把早期“通过”扩大解释为今天已部署或商业验证完成。
