# 邀请版部署

第一次部署请从[阿里云香港 Docker 新手教程](aliyun-hong-kong-docker-beginner.zh-CN.md)开始。最新真实 DeepSeek 和软件回归状态见[全量验收记录](../delivery/full-acceptance-2026-09-27.md)；[前轮接入记录](../delivery/deepseek-local-acceptance-2026-09-24.md)保留，不代替新一轮结果。

本版支持本机单用户模式和邀请账号模式。邀请模式中，账号和业务数据存放在运营者的 SQLite 卷；模型 Key 只在服务器环境变量中。浏览器不接收 Key，用户之间按认证身份隔离。默认 mock 无需模型凭证；它是有限的预设流程，不代表真实模型质量。最新软件与真实调用实测见[2026-09-27 记录](../delivery/full-acceptance-2026-09-27.md)。

当前验证边界：Windows 合成数据库、配置、浏览器、生产构建及两类真实 DeepSeek 完整业务流程已验证；这台机器没有 Docker、Podman 或已安装的 WSL，因此以下 Linux 镜像、卷权限、Caddy/HTTPS 和服务器命令属于部署模板，必须在目标 Linux 主机验收后才能对外使用。公网尚未部署，真实模型边界与残留详见上方记录。源码目录不是便携可执行程序。

## 拓扑与依赖

仅运行一个 Node 应用进程和一个 Caddy，禁止扩容副本、PM2 cluster 或多个写入服务。账号内最多 1 个、全局最多 2 个 Agent 回合的并发限制依赖单进程内存；SQLite 日配额持久化。只开放 Caddy 的 80/443；应用 3000 仅在 Compose 私有 bridge 网络可达，该网络允许模型出站。不要增加 app 的 `ports` 或直接暴露 Next。

镜像固定 Node `24.20.0-bookworm-slim`、pnpm `11.19.0` 和 Caddy `2.11.4-alpine`。这是精确版本标签，非内容摘要锁定；本机未拉取，目标机需确认标签可用并记录实际 digest。不要为绕过失败改成 latest。依赖按 frozen lockfile 安装且禁用生命周期脚本，仅对锁定的 better-sqlite3 13.0.3 执行其 `build-release`（该包没有 install 脚本），使用该 Node 镜像 npm 所带 node-gyp 和构建阶段的 Python/make/g++。构建产物覆盖相应 Linux prebuild 路径，使运行入口使用本次构建的原生模块。运行镜像故意保留完整依赖，保证 tsx、迁移和管理员 CLI 可解析；不是 standalone/pruned 镜像，构建工具链不进入最终层。

目标机先按 [Docker 的 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)准备 Docker Engine 与 Compose 插件。本次未替用户安装或开放防火墙。域名 DNS、证书签发连通性和服务器访问控制由运营者配置。

## 首次配置与启动（目标 Linux 主机）

在源码根目录，以下复制仅适用于文件不存在时：

```sh
test ! -e .env && (umask 077; cp deploy/.env.example .env)
```

在服务器私密编辑器中填写 `.env`：`APP_ORIGIN` 为唯一 HTTPS origin，例如 `https://coach.example.com`，不带路径、查询或凭据。示例域名必须换为自己控制的域名。Compose 固定 `APP_MODE=invite`、`DATABASE_PATH=/app/data/goal-coach.db`，不要在镜像内放 `.env.local`。本机开发的原有 `.env.local` 不应移动、改名、覆盖或上传。`.dockerignore` 从白名单构建上下文中排除环境文件、用户数据及日志。

```sh
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose run --rm --no-deps app pnpm deployment:check
sudo docker compose run --rm --no-deps app pnpm db:migrate
sudo docker compose run --rm --no-deps app sh -c 'test "$(id -u)" = 1000 && test -w /app/data'
sudo docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker compose up -d --build
sudo docker compose ps
```

`config --quiet` 避免把将来的 Key 展开到终端；不要粘贴完整 `config`、环境转储或 `docker inspect` 输出。app 以镜像内 node 用户 UID/GID 1000 运行。全新命名卷使用镜像 `/app/data` 的初始拥有者；若已有卷/绑定挂载不匹配，先在停止应用时由管理员核对准确卷和 UID/GID 后修正，不能把应用改成 root。验收必须确认数据库/WAL 的非 root 可写性、重启后数据保留和备份恢复。Caddy 的 `/data`（证书）及 `/config` 使用持久卷，不能随意清除。

容器启动依次校验配置、迁移、exec 单个 Next Node 进程。`/api/health` 检查本地认证/模型/配额配置与只读 SQLite 连通性，正常时返回无缓存的 200 `{ok:true}`，不可用时只返回 503 `{ok:false}`；不迁移、不创建主库、不调用模型，不披露路径、Key 或用户数量。mock 配置允许 Key/Base URL 为空。它不证明供应商可达或完整业务验收通过；Caddy 对公网该路径返回 404。Docker health 使用 Node fetch 访问容器内 loopback，不依赖 curl。首次发布还需从浏览器验证登录、邀请码、账号隔离、配额和退出；用 mock 完成，真实模型另行授权验证。

## 账号初始化

```sh
sudo docker compose exec app pnpm auth:admin bootstrap
```

输出一次性的管理员邀请凭证和过期时间，仅在私密终端查看，并在 `/login` 的注册入口粘贴。不要把凭证放入链接、日志、截图或文档示例。邀请有效期 72 小时；已有管理员或有效管理员邀请时 bootstrap 会拒绝重复创建。首位管理员注册后，在“账号管理”生成成员邀请、撤销未使用邀请、查看账号和禁用账号。禁用会立即废止该用户的会话；最后一个启用管理员不能被禁用。详细恢复步骤见[运维手册](operations.md)。

## 模型、同意与额度

保留 `MODEL_PROVIDER=mock` 时，Key 可为空。启用 DeepSeek 时运营者私下填写 `DEEPSEEK_API_KEY`，设置 `MODEL_PROVIDER=deepseek`；官方地址固定 `https://api.deepseek.com`，默认模型 `deepseek-flash`，`DEEPSEEK_MAX_OUTPUT_TOKENS=4096`（128–8192）。较长的结构化重排曾在 2048 输出限制下失败；4096 仍是有限的单次输出预算，不是人民币限额，也不保证模型总能生成有效方案。保留的 Qwen 使用独立 `DASHSCOPE_API_KEY` 与 HTTPS `DASHSCOPE_BASE_URL`，不能替代 DeepSeek Key。部署检查拒绝所选供应商缺凭据的配置，且不发网络请求。

每账号每日默认输入 100000、输出 30000 token，`DAILY_AGENT_TURN_LIMIT=50`（1–1000），按 Asia/Shanghai 自然日计算。邀请模式的提供方、模型及额度由服务器强制，账号不能在设置页提高；每个用户仍需对所选供应商和当前告知版本独立同意，撤回或换供应商会阻止未经重新同意的派发。已经发送的数据不能追回。本机 local 模式保留持久模型选择；环境变量提供默认值，不覆盖已有选择。

修改运营环境后先 `sudo docker compose config --quiet`，再 `sudo docker compose up -d --no-deps --force-recreate app`。供应商账单限制仍需单独设置和观察；超时未知用量、崩溃及一条回答跨过限额不能视作账单硬封顶。清除业务数据保留账号、安全记录和日配额，不能靠清除重置邀请版额度。

在本地源码目录执行 `pnpm eval` 是 30 例离线 mock；镜像不包含 evals 目录。单独授权后，私密本地源码可用 `pnpm eval:deepseek --allow-live` 或 `pnpm eval:live --allow-live`（Qwen）；脚本明示最多 5 例，直接调用必须显式给 `--max-cases=1..5` 和 `--allow-live`。程序缺少 opt-in 时会在加载 `.env.local`、建库、创建客户端及写结果前拒绝；它不能自行判断聊天授权。标志不代表费用许可，且没有逐案例账单硬上限；已结束的三轮 DeepSeek 结果另见最新接入记录，不自动重跑。

## 代理行为

Caddy 限请求体 262144 字节，与 API 256 KiB 一致；限制头部读取 15 秒、请求体读取 30 秒，响应等待/写出为 15 分钟。Agent 最多四次、每次 45 秒模型调用，长响应等待覆盖其串行调用余量；这不延长应用自己的模型超时。代理 idle keepalive 30 秒，小于明确设置的 Node 65 秒，避免复用已被后端关闭的连接。代理不重试 POST；未知结果按应用相同操作标识查状态，不能通过重试产生新计费回合。配置依据 [request_body](https://caddyserver.com/docs/caddyfile/directives/request_body) 与 [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 官方说明，尚需 Linux 实际验证。

## 本机命令备用入口

若当前 Windows shell 的 pnpm/Node 解析异常，可仅在此已知安装环境使用：

```powershell
$env:PATH = 'D:\NodeJS;' + $env:PATH
& 'node' 'C:\Users\YOUR_USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.mjs' --version
```

其余 pnpm 参数接在该 CLI 路径之后。接收方机器的安装位置可能不同；不要把本机路径当通用安装说明，也不要升级运行时或锁定依赖来绕过路径问题。
