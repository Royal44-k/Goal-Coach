# 资产清单

归档范围：Goal Coach 项目中可恢复、与交付有关、适合公开的资产。不是整个电脑或所有聊天的备份。来源与脱敏边界见[来源说明](provenance.md)。

| 资产类别 | 位置 | 用途与状态 |
| --- | --- | --- |
| 动态网页、API、Agent 与业务服务 | `src/` | 可运行实现；后端保存状态，不是静态展示页 |
| SQLite 迁移与 ORM 配置 | `drizzle/`、`drizzle.config.ts` | 新库初始化及版本迁移；不含实际用户库 |
| PWA 静态资产 | `public/` | 图标、离线页和受限缓存脚本；不缓存私人页面 |
| 工具与管理脚本 | `scripts/` | 启动、配置检查、账号管理、备份恢复、源码打包 |
| 自动化测试与评测 | 源码旁测试、`e2e/`、`e2e-invite/`、`evals/` | 免费回归与显式启用的付费模型评测；原始结果不提交 |
| 锁定运行环境 | `package.json`、`pnpm-lock.yaml`、`.node-version` 等 | Node 24.20.x / pnpm 11.19.x；不提交依赖目录 |
| Docker 与 HTTPS 模板 | `Dockerfile`、`compose.yaml`、`deploy/` | 单节点邀请制部署；目标 Linux/域名验收尚待执行 |
| 当前规格 | [项目规格](../specification/project-spec.zh-CN.md) | 产品边界、架构、状态、工具、安全与验收基线 |
| 使用与上线教程 | [本地启动](../guides/quickstart.zh-CN.md)、[使用](../guides/user-guide.zh-CN.md)、[阿里云教程](../deployment/aliyun-hong-kong-docker-beginner.zh-CN.md)、[运维](../deployment/operations.md) | 按顺序学习和部署 |
| 历史设计与计划 | `docs/superpowers/specs/` 5 份、`docs/superpowers/plans/` 5 份 | 决策沿革；旧路径匿名化，旧指令不自动获得执行授权 |
| 技术调研与重审 | `docs/research/` 3 份 | Qwen、DeepSeek/PWA 路线、阿里云官方资料笔记 |
| 学习与验收记录 | `docs/learning/`、`docs/delivery/` | 演练说明、已做验证与未覆盖边界 |
| 场景案例 | [案例入口](../examples/README.md) | 2 条真实 DeepSeek 合成场景摘录；不是客户成功案例 |
| 实际界面截图 | `docs/examples/images/` | 3 张 mock 浏览器验收截图，来源和 SHA-256 已记录 |
| 安全及使用权说明 | [SECURITY](../../SECURITY.md)、[NOTICE](../../NOTICE.md) | 公开资料边界、已知风险；尚未选择开源许可 |

## 明确不上传

- `.env.local`、服务器 `.env`、API Key、登录密码、邀请码、Cookie、SSH/Git 凭据。
- 实际数据库、WAL/SHM、备份、用户导出、私人对话和原始模型评测日志。
- `node_modules`、`.next`、开发缓存、临时工作树、浏览器追踪、录屏和整个个人工作区。
- 原开发 `.git` 历史、私人作者邮箱、未脱敏旧 ZIP；接受基线 ZIP 原件保留在拥有者本机，不冒充本仓库附件。

## 缺失或未形成的资产

早期独立市场调研原稿、真实客户访谈、收益/留存数据、正式商用条款、已上线域名、Linux Docker 实测报告和真实手机安装视频不在本次交付内。不会用合成数据补造。上线检查单将这些后续工作与已有本机证据分开记录。
