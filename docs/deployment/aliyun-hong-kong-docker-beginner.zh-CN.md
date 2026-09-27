# Goal Coach：DeepSeek 接入与阿里云香港 Docker 上线教程

适用版本：Goal Coach 0.2.2。官方资料初核：2026-09-24；公开仓库操作路径整理：2026-09-27。读者：第一次配置 API、租服务器和部署网站的使用者。

这是一份操作教程，不是“已经完成公网部署”的证明。真实调用、本机启用与云端验收结果另见[全量验收记录](../delivery/full-acceptance-2026-09-27.md)。只有完成对应检查，才能把该阶段标记为通过。使用者自行决定是否购买资源和发起收费调用；历史验收授权不代表新使用者同意消费。

**当前交付为本机可运行的 0.2.2 与云端部署教程，不是已上线网站。** 学习和轻工作两类真实 DeepSeek 完整流程已通过机械及内容核对（明确恢复原可用时间后），审批、证据保留、估时与容量保护均纳入自动化回归。模型复盘措辞仍可能不够准确；最新容量负例因实际没有冲突未覆盖到，不能说真实模型所有边界都已通过。旧 0.2.1 包是历史快照，请使用本轮核验的 0.2.2，并在目标 Linux 主机完成后半篇验收后再邀请朋友。

## 0. 最终得到什么

一个有账号、数据库、后端和 AI 交互的动态应用。电脑通过网站使用；手机访问同一网站并安装到主屏，成为 PWA。它不是只有页面的静态网站，也不是需要应用商店下载的原生安装包。

```text
电脑浏览器 / 手机 PWA
        │ HTTPS：你的域名
        ▼
阿里云中国香港 ECS
  Caddy：证书、HTTPS、反向代理
        │ Docker 内部网络
        ▼
  Goal Coach：Next.js 页面 + Node.js 后端（单进程）
        ├── SQLite 持久卷：账号、目标、任务、对话、配额
        └── HTTPS → DeepSeek：只有后端持有 API Key
```

首版不需要另外购买 RDS 数据库、Redis、Kubernetes，也不需要把现有项目重写为 Flutter。以后增长到多台应用服务器时，再设计共享数据库和分布式限流；不要直接复制多个当前 app 容器。

几个词先认识：

| 名词 | 在本项目中的意思 |
| --- | --- |
| API Key | DeepSeek 调用凭证，使用它会产生你的模型账单 |
| ECS | 阿里云上持续开机的 Linux 电脑 |
| 域名 / DNS | 网站名字 / 把名字指向服务器公网 IP 的记录 |
| SSH | 从你的电脑安全连接服务器终端 |
| 镜像 / 容器 | 打包好的运行环境 / 实际运行的程序实例 |
| Compose | 同时配置和启动 app、Caddy 的工具 |
| 卷 volume | 容器之外持久保存数据库、证书的存储；不是备份 |
| HTTPS | 加密连接，也是公网 PWA 安装等能力的前提 |

建议顺序：本机配置 → 本机验收 → 准备服务器和域名 → 安装 Docker → 上传源码 → mock 验证基础设施 → 云端启用 DeepSeek → 备份恢复演练 → 邀请朋友。

## 1. 阅读与操作规则

- 标注 **Windows PowerShell** 的命令在你自己的电脑执行；标注 **服务器 Bash** 的命令先 SSH 登录服务器后执行。不要交叉粘贴。
- 每个命令块完成后检查结果；出现红色错误、`failed`、非零退出码就停在这一步，不继续执行后面可能写数据的命令。
- `example.com`、示例 IP、用户名都需要替换。示例不是可用的服务器。
- 不把 Key、密码、邀请码、Cookie、数据库、备份发到聊天、公开仓库或截图里。排错只分享脱敏报错。
- 本指南的云端主线路径是**新购、空白 Ubuntu 24.04 x86_64 服务器**。已有其他业务或已有 Docker 的服务器不直接套用安装步骤。
- 本项目核验组合为 Node 24.20.0 / pnpm 11.19.0；先检查自己的机器是否匹配。服务器由 Dockerfile 准备这些版本，不要求你在 ECS 再手工装一套 Node。

## 2. 在本机私下配置 DeepSeek

### 2.1 密钥、余额与地址

在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)管理 Key，在平台查看账户余额与用量。聊天产品能用，不等于 API 一定有可用余额。密钥不放在网页表单、浏览器代码或 `NEXT_PUBLIC_` 开头的变量里。

当前应用支持的默认组合是 `https://api.deepseek.com` 与 `deepseek-flash`；另支持 `deepseek-v4-pro`。首轮按 Flash 验收，不自行换模型或第三方转发站。依据：[官方入口](https://api-docs.deepseek.com/)、[模型和计费](https://api-docs.deepseek.com/quick_start/pricing/)。

### 2.2 找到准确文件

先完成[本地启动指南](../guides/quickstart.zh-CN.md)，在克隆出的项目根目录确认能看到 `package.json`。配置文件是该目录下的 `.env.local`，不是你的用户目录，也不是 `src/` 内的文件。

**Windows PowerShell / 项目根目录**：

```powershell
if (-not (Test-Path -LiteralPath '.env.local')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
}
notepad .env.local
```

已有配置不会被这段命令覆盖。打开资源管理器的文件扩展名显示，避免保存成 `.env.local.txt`。

在已有文件中查找并修改以下项；没有的才新增，每项只保留一行：

```dotenv
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=在这里填写你自己的完整密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_MAX_OUTPUT_TOKENS=4096
```

保留原来的 `DATABASE_PATH` 和其他设置，不用上面片段覆盖整个文件。不要填中文示例文字、不要加中文引号、不要把变量名误写成 `DEEPSEEK API KEY`。按 `Ctrl + S` 保存，确认文件名没有变成 `.env.local.txt`。关闭编辑器或共享屏幕前不要截图。

若你在系统环境变量里设置过同名配置，它可能优先于文件生效；不要用输出全部环境变量的方法排查。由程序只报告“Key 是否存在、模型名是否支持、输出限制是否有效”即可。

### 2.3 配置成功不等于接入成功

需要四层验证：

1. 配置检查通过：不调用模型、不收费。
2. 一次受限真实评测：验证 Key、余额、网络和工具协议。
3. 业务验证：目标澄清、草案确认、任务与复盘等操作保持一致。
4. 内容评审：建议是否具体、合理、尊重约束，而不是只有自然语言回复。

本地设置页可能保存着原来的 `mock` 选择。环境变量是默认值，不会强制覆盖已保存的选择；新版启动后，在“设置”确认选中 DeepSeek，并阅读和同意相应数据使用说明。每个邀请账号也要独立同意。撤回同意可以停止后续模型派发，但不能追回已经发送给供应商的数据。

### 2.4 真实评测的费用边界

既有脚本 `pnpm eval:deepseek --allow-live` 最多选择 5 个案例，每案例最多 4 次模型请求。DeepSeek 当前建议每次最多输出 4096 token，避免较长的结构化重排在原 2048 限制处被截断；实际输出可能更少。此设置只限制单次输出，不限制输入、不构成人民币硬上限。当前选的是数组前五例 L01–L05，均为学习目标澄清，不代表所有业务阶段。

这个命令**会收费，不在一般排错中反复运行**。9 月 24 日前三批实际为 8 次、11 次、6 次请求，均已结束。9 月 27 日用户另行授权完整业务验收及必要修正复验，取代旧批次请求数限制；实际用量和失败也记录在全量验收报告中，不无限重跑来掩盖问题。`--allow-live` 是程序开关，不代替费用授权；应用的审批、配额和每回合限制仍保留。

如果需要你自行复现，必须在已确认计费后，于项目目录的 Windows PowerShell 中执行：

```powershell
# 在克隆后的项目根目录执行
node --import tsx evals/run.ts --provider=deepseek --max-cases=5 --allow-live
```

上面只测目标澄清。完整业务链采用独立验收器（同样会收费，默认不自动运行）：

```powershell
node --import tsx evals/lifecycle-run.ts --provider=deepseek --allow-live --scenario=learning
# 轻量工作场景，把最后一个参数换为 --scenario=light_work
```

该验收器用同一个合成目标贯穿草案、可信批准、执行、撤销、证据、阻碍、重排、复盘、完成与导出。模型输出不合法时该场景失败并保留结果，不插入手写草案代替模型过关；案例完成证据明确是合成记录，不代表真实用户的实际成果。

另有明确命名的验收分支，只在需要复现且已确认计费时使用：给指定场景命令增加 `--replan-mode=confirm-more-time`，合成用户会明确把每周可用时间恢复为原值（学习240、轻工作180分钟）后继续重排，输出 `learning_user_chose_more_time.json` 或 `light_work_user_chose_more_time.json`，不声称仍以减半时间完成，也不能与 `--scenario=all` 混用。仅学习命令支持 `--replan-mode=expect-capacity-conflict`，它检查实际超量时的安全拒绝，输出 `learning_capacity_conflict.json`，不代表目标完成。如果计划没有实际冲突、模型未走到该分支或早期发生其他错误，该分支不能算通过，更不能反复试到通过为止。

模型重排采用保守策略：不能通过改措辞或合并任务，把当前未完成任务总估时自动压低。这不证明估时一定准确；如果你确有工具、经验或范围变化带来的提效，可在已有手动修改计划界面审阅估时并确认。容量不足时应调整真实可用时间、重新审阅范围或期限，不让模型悄悄减少工作来凑数。所有草案仍需确认；拆出小步骤后还应检查其产物进入后续交付和验证。

不要连续点击重试。不确定上一次是否成功时，先核对本地结果和供应商用量。评测使用合成目标与内存库，不操作原练习数据库；结果位于本机 `evals/results`，不是可直接公开的材料。

## 3. 本机运行与验收

### 3.1 在你自己的机器运行

从[本地启动指南](../guides/quickstart.zh-CN.md)完成版本检查、安装锁定依赖、创建配置和数据库迁移。开发运行用 `pnpm dev`；检查生产运行时，在该进程自己的终端按 `Ctrl + C` 停止后，执行：

```powershell
pnpm build
if ($LASTEXITCODE -ne 0) { throw '构建失败，停止操作' }
pnpm local:check
if ($LASTEXITCODE -ne 0) { throw '配置或构建检查失败，停止操作' }
pnpm local:start
```

看到 Ready 后打开 `http://127.0.0.1:3000/`，保留终端窗口。端口被占用时核对自己的进程，不执行“关闭所有 node 进程”。生产服务不会随源码修改自动更新，修改后需重新构建、重启。

GitHub 源码不含 Key、用户数据库、依赖或已构建服务。历史验收记录中开发机的 3400 端口和独立库只是当时的证据，**不是克隆后已经存在的入口或文件**。当前指南不依赖那份私有运行副本。

### 3.2 已有数据和分享边界

升级旧实例之前先确认准确源库，用项目 `db:backup` 生成已校验快照，在副本试迁移成功后再切换。不要拿原练习库作测试夹具或删除旧库“重新开始”。备份方法见[运维手册](operations.md)。

`127.0.0.1` 仅指当前设备；不是朋友能访问的地址。关闭本机服务或电脑后，本机网站停止。少量朋友长期使用应继续完成云端、HTTPS、邀请账号和备份检查。不要把没有认证的 local 模式暴露到公网。

### 3.3 本轮验收标准

本机自动化验收由开发侧执行，结果见全量验收记录；下面列的是复现标准，不要求你再替开发重复手测。只有后续目标服务器、域名 HTTPS 和真实手机等尚不存在的运行环境，需要在具备条件后补做现场验收。不要为了“确认一下”反复运行第2.4节的收费命令。

| 层次 | 通过条件 | 不能替代什么 |
| --- | --- | --- |
| 代码回归 | 类型、规范、单元/集成与模拟评测通过 | 不证明真实模型可用 |
| 浏览器操作 | 建目标、确认草案、执行/修改、统一撤销、复盘、设置与数据管理通过 | 不等于所有真实回答都优质 |
| 真实 API | 正确提供方、工具调用受限、无未批准结构变更、用量可观察 | 5 个学习案例不是全业务覆盖 |
| 本机服务 | 新版本能启动、刷新读回数据、重启数据保留 | 不等于公网或手机验收 |
| 内容价值 | 不凭空替用户改目标；行动具体、有时间约束、有完成证据 | 不保证收入、留存或个人成果 |

建议用“4 周完成一个 TypeScript 待办网页，每天 1 小时”作为第一条合成目标。正确流程是澄清 → 契约草案 → 你确认 → 计划草案 → 你确认 → 执行/打卡 → 复盘与调整。只看到聊天文字不算完整通过。

## 4. 准备云端资源：先看费用再购买

准备三样：阿里云账号（开启多因素验证）、自己控制的域名、DeepSeek API 账户。没有域名时先完成本机，不用公网 HTTP/IP 地址冒充正式 PWA。

建议首批邀请少量朋友时从 **中国香港 ECS、2 vCPU / 4 GB 内存、40 GB SSD 系统盘、Ubuntu 24.04 LTS x86_64** 起步。这是工程起点，不是压测结论或套餐保证；Next 构建也消耗内存。控制台的库存、镜像兼容性和最终价格以购买页为准。[创建 ECS](https://www.alibabacloud.com/help/en/ecs/user-guide/create-an-instance-by-using-the-wizard)、[Ubuntu 镜像](https://www.alibabacloud.com/help/en/ecs/ubuntu-image)。

在阿里云控制台搜索“云服务器 ECS”→“创建实例”→选择自定义购买，逐项检查：

| 项目 | 首版选择 / 注意事项 |
| --- | --- |
| 地域 | 中国（香港），不要误选华南或其他地域 |
| 实例 | 普通 x86_64，起步 2 核 4 GB；不选抢占式用于持续试用 |
| 镜像 | 官方公共镜像 Ubuntu 24.04 64 位；不选第三方预装宝塔/商业应用镜像 |
| 磁盘 | 起步 40 GB；监控构建镜像、数据库、日志和备份占用 |
| 公网 | 勾选分配公网 IPv4，否则朋友无法直接访问 |
| 带宽 | 先设置小规模上限，例如 5 Mbps；这是体验起点，不是性能承诺 |
| 付费方式 | 按量适合短期试验但需持续看账单；包月先看总价与续费，不盲目选多年 |
| 登录方式 | 首选 SSH 密钥对，私钥只保存在自己电脑；也可先用强密码并尽快完成密钥登录 |
| 自动续费/快照 | 逐项确认是否开启、收费多少、到期是否会停机或丢数据 |

公网流量计费与固定带宽计费不同，ECS、系统盘、快照、域名、模型分别收费。不要把“模型便宜”当作网站总成本。配置阿里云费用提醒；能设置供应商费用限制时也设置，但以账户控制台实际能力为准。[公网带宽计费](https://www.alibabacloud.com/help/en/ecs/public-bandwidth)。

购买完成后记下：实例 ID、地域、公网 IPv4、登录用户名、到期时间。不要记录或分享明文密码。后面示例公网地址 `203.0.113.10` 是文档保留地址，必须换成实例真实公网 IP。

## 5. 安全组、SSH、域名

### 5.1 安全组

实例详情 → 网络与安全 → 安全组 → 入方向规则。核对默认规则，避免留着“所有端口对所有人开放”。

| 协议 / 端口 | 来源 | 用途 |
| --- | --- | --- |
| TCP 22 | 你当前公网 IPv4/32 | 直接 SSH 运维，不对所有人开放 |
| TCP 80 | `0.0.0.0/0` | HTTP 跳转与证书验证 |
| TCP 443 | `0.0.0.0/0` | HTTPS 网站 |
| UDP 443 | 可选 `0.0.0.0/0` | HTTP/3；不是基础 HTTPS 的必需条件 |

不开放 3000，不开放数据库端口，不添加 app 的 Docker `ports`。外层安全组仍然重要，因为 Docker 的发布端口可能绕过 UFW 规则；不要只依赖 UFW。[安全组](https://www.alibabacloud.com/help/en/ecs/user-guide/start-using-security-groups)、[Docker 端口发布](https://docs.docker.com/engine/network/port-publishing/)。

当前公网 IP 可从你自己的路由器状态或安全组控制台的“我的 IP”辅助项确认；家庭宽带/VPN 切换后可能变化。不要为了图方便把 22 长期开放给 `0.0.0.0/0`。

### 5.2 从 Windows 连接服务器

**Windows PowerShell**，下面的 `ubuntu` 应替换成实例实际登录用户（控制台显示什么就用什么）：

```powershell
ssh -V
ssh ubuntu@203.0.113.10
```

密钥对登录则使用自己保存的私钥路径，例如：

```powershell
ssh -i 'C:\Users\YOUR_USER\.ssh\goal-coach.pem' ubuntu@203.0.113.10
```

第一次提示主机指纹时，先通过可信的阿里云控制台会话核对服务器 `/etc/ssh/ssh_host_ed25519_key.pub` 指纹（服务器命令 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`）。一致后再接受。不要用关闭主机校验的参数绕过。密码输入时不会显示字符，这是正常现象。

如果 Windows 没有 `ssh`，可在系统“可选功能”安装 OpenSSH 客户端，或使用阿里云 Workbench。Workbench 经 SSH 连接时来源是阿里云服务地址，不是你的电脑 IP：按[官方 Workbench 说明](https://www.alibabacloud.com/help/en/ecs/user-guide/workbench-overview/)配置其当时所需来源范围。不要把“我的 IP 才能连”的规则误认为自动允许 Workbench。Session Manager 与 SSH 的前提和文件传输能力也不同。

进入后执行 **服务器 Bash**：

```bash
whoami
uname -m
cat /etc/os-release
```

应确认 x86_64、Ubuntu 24.04。若你首次登录为 root，可创建专用维护账号：`adduser coachops`，再 `usermod -aG sudo coachops`。按 Ubuntu 的安全方法给该账号配置你自己的 SSH 公钥并在第二个窗口验证登录；验证前不要关闭原会话，也不要先禁用唯一可用登录方式。此后使用有 sudo 权限的非 root 维护账号。

### 5.3 域名解析

在你域名的**实际 DNS 服务商**添加记录，不一定是购买域名的平台。假定你拥有 `your-domain.com`，希望使用 `coach.your-domain.com`：

- 记录类型 A；主机记录 `coach`；记录值 ECS 公网 IPv4；TTL 先用平台默认。
- 暂不接 CDN、代理或多地域负载均衡，避免引入新的证书/备案/缓存变量。
- 不配置错误的 AAAA。已有 AAAA 必须指向可达 IPv6，否则修正或移除这个不适用记录。

**Windows PowerShell**：

```powershell
Resolve-DnsName coach.your-domain.com -Type A
```

返回值应包含你的 ECS 公网 IP。DNS 更新可能有缓存，不要因为刚保存一分钟还未一致就反复改配置。[阿里云 DNS 添加记录](https://www.alibabacloud.com/help/en/dns/pubz-add-parsing-record)。

## 6. 在新 Ubuntu 服务器安装 Docker

以下全部是 **服务器 Bash**。使用官方签名软件源，不执行来历不明的“一键部署”脚本。具体安装依据[Docker Ubuntu 文档](https://docs.docker.com/engine/install/ubuntu/)。

先确认服务器是本指南约定的全新系统；如果已经有 Docker/containerd 或其他网站，停止本节安装并单独规划，不卸载既有运行环境。

```bash
command -v docker
sudo systemctl status docker --no-pager
```

全新机器显示未安装/服务不存在是预期；不是需要删除目录来“修复”。开始安装：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl nano git
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl --fail --show-error --silent --location https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc
sudo chmod 0644 /etc/apt/keyrings/docker.asc
sudo nano /etc/apt/sources.list.d/docker.sources
```

最后一条打开编辑器。在**Ubuntu 24.04 amd64** 中填入以下内容；若文件已有内容，不盲目覆盖：

```text
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
```

nano 保存：`Ctrl + O` → 回车；退出：`Ctrl + X`。随后：

```bash
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

看到 hello-world 成功提示、Compose 输出版本号，才继续。后面的教程统一使用 `sudo docker`，无需把账号加入具有高权限的 docker 组。Docker 自身的服务器版本与应用镜像内的 Node 版本不是同一件事。

如果软件源或 Docker Hub 超时，先检查 DNS、出网和官方服务状态；不关闭 TLS 校验，不随意换不可信镜像站，不把应用依赖升级到 latest 来绕过网络问题。

## 7. 从 GitHub 获取公开源码，不上传本机秘密

仓库为 [Royal44-k/Goal-Coach](https://github.com/Royal44-k/Goal-Coach)。本次公开版包含运行源码、规格和教程，不含私密环境、数据库、`node_modules` 或已构建应用。公开快照与原交付 ZIP 的区别见[来源说明](../assets/provenance.md)。

在 GitHub 仓库的提交记录中选择经过核验的版本，并保存其完整 commit SHA。下面先克隆主分支；**主分支今后会变化，执行构建前必须核对克隆后的 commit 与你选择的版本一致**。不把历史原 ZIP 的哈希拿来校验 GitHub 自动生成的 Download ZIP。

**服务器 Bash**（使用已登录的维护账号）：

```bash
git --version
sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" /opt/goal-coach
test ! -e /opt/goal-coach/release-0.2.2 || { echo '发布目录已存在，停止，另选新目录'; exit 1; }
git clone https://github.com/Royal44-k/Goal-Coach.git /opt/goal-coach/release-0.2.2
cd /opt/goal-coach/release-0.2.2
git rev-parse HEAD
git status --short
ls -a
```

逐条执行；克隆失败立即停下，不继续在其他目录执行后续命令。此目录应包含 `package.json`、`compose.yaml`、`Dockerfile` 和 `deploy/Caddyfile`，`git status --short` 应为空。

若克隆出的 SHA 不是你选定的版本，先确认选定 SHA 确实属于该仓库、当前目录没有任何用户改动，再使用 `git switch --detach 完整提交SHA`；核对 `git rev-parse HEAD` 完全一致。不要用强制重置覆盖已有工作。后文所有 Compose 命令均在 **`/opt/goal-coach/release-0.2.2`** 执行。

GitHub 仓库公开读取不需要上传你本机的 Git 凭据或 API Key。如果网络不通，修复 DNS/出网或使用可信下载渠道，不关闭 TLS 校验。不要 scp 整个开发目录。服务器私密配置在下一节单独创建。

## 8. 创建服务器私密配置

仍在 **服务器 Bash / 源码根目录**：

```bash
test ! -e .env || { echo '.env 已存在，请核对，不能覆盖'; exit 1; }
umask 077
cp deploy/.env.example .env
chmod 600 .env
nano .env
```

第一阶段只设置自己的真实域名，保留 mock，先把账号、数据库、HTTPS 跑通：

```dotenv
APP_ORIGIN=https://coach.your-domain.com
MODEL_PROVIDER=mock
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_MAX_OUTPUT_TOKENS=4096
DAILY_INPUT_TOKEN_LIMIT=100000
DAILY_OUTPUT_TOKEN_LIMIT=30000
DAILY_AGENT_TURN_LIMIT=50
GOAL_COACH_DATA_VOLUME=goal-coach-data-v020
GOAL_COACH_IMAGE=goal-coach-agent:0.2.2
```

这是需要核对的片段，不要求删掉示例中其余 Qwen 保留项。`APP_ORIGIN` 只填唯一 `https://域名`，不带页面路径、查询参数或 `:3000`。容器中邀请模式和 `/app/data/goal-coach.db` 已由 Compose 指定。

本机 `.env.local` 与服务器 `.env` 是两份不同配置。本机配好 Key 不会自动传到云端。服务器环境值由 Compose 注入；不要再在容器内创建 `.env.local`。

## 9. 构建、检查、启动

每条命令成功后再执行下一条；首次构建可能较慢，等待它完成，不同时打开多份构建。构建失败时不要继续 bootstrap。

```bash
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose run --rm --no-deps app pnpm deployment:check
sudo docker compose run --rm --no-deps app pnpm db:migrate
sudo docker compose run --rm --no-deps app sh -c 'test "$(id -u)" = 1000 && test -w /app/data'
sudo docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker compose up -d --no-build
sudo docker compose ps
```

预期：配置检查通过、迁移退出 0、权限检查退出 0、Caddy 配置有效；app 最终显示 healthy，Caddy running。刚启动短暂显示 starting 可以稍候再次查看；持续 unhealthy 则排错。

不要运行不带 `--quiet` 的 `compose config` 并把结果发给别人，因为它会展开 Key。不要共享完整 `docker inspect` 或环境变量转储。[Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)。

容器内健康检查，不收费：

```bash
sudo docker compose exec app node -e 'fetch("http://127.0.0.1:3000/api/health").then(async r=>{if(r.status!==200 || !(await r.json()).ok) process.exit(1); console.log("内部健康检查通过")}).catch(()=>process.exit(1))'
```

然后在自己电脑的浏览器打开 `https://coach.your-domain.com/login`。应有 HTTPS 锁标志和登录/注册界面；证书警告不能点“仍然继续”当作通过。首次 Caddy 签发证书需要 DNS 正确、TCP 80/443 可达及证书卷可写。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。

公网访问 `/api/health` 得到 **404 是项目故意的安全策略**，不要因此把 3000 端口开放到公网。健康检查在容器内部进行。

本项目只允许一个 app 实例；不要 `--scale app=2`，不要加入 PM2 cluster。源码选择保留迁移/管理所需依赖，不是可随意裁剪的静态或 standalone 目录。

## 10. 注册自己为管理员，再创建朋友邀请

在私密服务器终端执行一次：

```bash
sudo docker compose exec app pnpm auth:admin bootstrap
```

它显示一次性管理员邀请码及有效期。关闭录屏，只自己保存；不发到聊天，不放在 URL，不把管理员邀请当朋友邀请。邀请码有效 72 小时；已有管理员或尚有效的管理员邀请时，重复 bootstrap 会被拒绝。

在浏览器 `/login` 选择注册，输入邀请码、账号名、密码：

- 账号名 3–32 位，只用英文字母、数字、下划线、短横线。
- 密码 12–128 位，使用独立强密码，保存在密码管理器里。
- 注册后确认能登录和退出；再登录进入“账号管理”（`/admin`）。

管理员界面创建**成员邀请**，每位朋友一份；同时私下发送网站 HTTPS 链接和邀请码。不要发自己的账号密码。可以撤销未使用邀请、禁用账号；禁用会使该账号已有会话失效。后台的账号管理不提供浏览其他人的目标，但拥有服务器/数据库权限的运营者仍可能访问数据，不能宣传端到端加密。

此时仍用 mock 检查注册、双账号隔离、手动目标操作和持久化。mock 是有限预设流程，不能用于判断 DeepSeek 的自然语言理解质量。

## 11. 在云端启用 DeepSeek

基础设施检查通过后，在私密终端编辑服务器 `.env`：

```bash
nano .env
```

将 `MODEL_PROVIDER` 改为 `deepseek`，填写你自己的 `DEEPSEEK_API_KEY`；保持官方地址、Flash 模型和 4096 输出限制。保存退出。不要把 Key 写在 `export ...` 命令里留下历史。

```bash
sudo docker compose config --quiet
sudo docker compose run --rm --no-deps app pnpm deployment:check
sudo docker compose up -d --no-deps --no-build --force-recreate app
sudo docker compose ps
```

这里只重建 app 容器，不删除数据卷。单独 `docker compose restart app` 不足以应用更改的 Compose 环境值；要重建容器。再次运行第 9 节内部健康检查。

登录自己的账号 → 设置 → 阅读 DeepSeek 数据使用说明 → 同意。邀请模式由服务器固定提供方和额度，朋友不能换模型或提高配额。先用合成目标完成一条真实流程，并检查 DeepSeek 控制台用量，再逐步邀请朋友。服务器上的真实交互是新的付费调用，不包含在本机那一轮固定评测里。

默认每日限制是**每账号**输入 100000 / 输出 30000 token、50 个 Agent 回合，按上海自然日计算；不是全站人民币总预算。首批可按观察结果在服务器适当降低并重建 app；缩短额度可能使长对话更早停止。当前超时/未知用量等情况不提供严格账单封顶。

紧急停止新增模型调用：先暂停邀请；需要立即停止时正常 `sudo docker compose stop app`（网站暂时不可用），再私下把提供方改回 mock，配置检查后重新启动。已经发往供应商的请求可能仍被计费；泄露 Key 时还要在 DeepSeek 平台撤销旧 Key。不要指望清数据库或删除容器能取消供应商账单。

## 12. 手机安装 PWA

朋友必须先通过 HTTPS 网站注册/登录。电脑 `127.0.0.1` 地址不能给朋友用；手机的这个地址指向手机自己。

- iPhone/iPad：用 Safari 打开 HTTPS 网站 → 分享 → 添加到主屏幕 → 添加。再次从图标打开并确认登录、输入框、返回导航正常。
- Android：用 Chrome/Edge 系统浏览器打开 → 站内安装入口或浏览器菜单“安装应用/添加到主屏幕”。微信等内嵌浏览器没有安装提示时，选择在外部浏览器打开或复制链接。
- 安装入口名称会随系统/浏览器变化；优先按当前界面操作。网站与 PWA 使用同一后端，不要另建一份孤立数据库。

本版断网时只显示静态离线说明，不会把私人对话缓存为离线页面，也不支持离线写入后自动同步。恢复网络后刷新。不是应用商店上架，不自动具备原生推送、系统常驻或后台定时能力。

真机检查至少包括：安装、冷启动、注册登录、键盘不遮挡输入、长内容滚动、退出后不可访问私人页、断网说明、恢复网络、更新版本。桌面窄屏截图不能替代这些检查。系统操作依据：[Apple 主屏幕 Web App](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)、[Chrome Android Web App](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=zh-Hans)。

## 13. 备份：上线当天就做

卷能在容器重建后保留数据，但服务器磁盘损坏、误删卷和账号入侵仍会丢数据。必须另存离机备份。备份包含账号凭证哈希、会话和业务数据，需要加密、限制访问、设置保留期。

**服务器 Bash**，先使用项目 SQLite 备份脚本，不直接复制正在运行的 `goal-coach.db`：

```bash
cd /opt/goal-coach/release-0.2.2
install -d -m 0700 backups
backup_name="backup-$(date -u +%Y%m%dT%H%M%SZ).db"
test ! -e "backups/$backup_name" || { echo '备份目标已存在，停止'; exit 1; }
sudo docker compose exec -T app pnpm db:backup -- "/app/data/$backup_name"
```

上一条必须明确显示成功，才复制到宿主机：

```bash
sudo docker compose cp "app:/app/data/$backup_name" "backups/$backup_name"
sudo chown "$(id -u):$(id -g)" "backups/$backup_name"
chmod 600 "backups/$backup_name"
sha256sum "backups/$backup_name"
```

脚本包含 WAL 中已提交的数据并校验完整性、外键；生成独立快照。记录文件名、UTC 时间、哈希、应用版本。不要重复使用旧文件名。复制失败时先核对目标，不覆盖已有备份。

用 scp 把**刚才实际生成的文件名**下载到自己电脑。以下是 **Windows PowerShell**，另开一个本机终端，不在 SSH 服务器窗口执行：

```powershell
$backupDirectory = 'D:\GoalCoach-Private-Backups'
if (-not (Test-Path -LiteralPath $backupDirectory)) {
  New-Item -ItemType Directory -Path $backupDirectory | Out-Null
}
```

这个目录要位于自己控制的加密磁盘/加密容器上，并在 Windows 文件夹“属性 → 安全”中核对只允许自己的维护账号及必要系统主体访问；不要选择公共用户目录或共享/自动公开同步目录。若没有加密备份工具，先完成 Windows 设备/磁盘加密与恢复密钥的独立保管，再保存真实用户备份。不要把加密密码与备份放在一起。

将下面文件名换成服务器刚输出的实际名称，把 `ubuntu` 与示例 IP 换成实际维护账号和公网 IP。目标存在时拒绝覆盖：

```powershell
$backupFile = 'backup-20260924T100000Z.db'
$backupTarget = Join-Path $backupDirectory $backupFile
if (Test-Path -LiteralPath $backupTarget) { throw '本机目标已存在，停止，核对备份名称' }
scp "ubuntu@203.0.113.10:/opt/goal-coach/release-0.2.2/backups/$backupFile" $backupTarget
if ($LASTEXITCODE -ne 0) { throw '下载失败，不把该文件当作成功备份' }
Get-FileHash -LiteralPath $backupTarget -Algorithm SHA256
```

私钥登录同样给 scp 添加 `-i '私钥完整路径'`。将输出的 SHA-256 与服务器 `sha256sum` 输出逐字符对比；一致才记录为下载成功。先不删除服务器副本。再把已加密备份存到另一处受控离机存储，完成一次解密/恢复演练，不上传普通网盘公开链接。备份也占服务器磁盘，定期按明确保留策略清理已确认有离机副本的准确文件；不要运行宽泛删除命令。

首批建议每日备份、每次升级前额外备份、定期恢复演练。这里没有替你创建自动备份任务；手动连续执行并检查成功后，再配置经过审查的自动备份和失败提醒。

## 14. 恢复、重启与升级：避免把数据误删

### 14.1 恢复演练必须真的做

完整恢复步骤和 Linux 只读挂载合成验证见[运维手册的恢复章节](operations.md)。第一次上线先用**合成测试账号和目标**演练，不能把朋友真实数据当随意回滚的测试数据。

核心顺序：停 Caddy/app → 保留旧卷 → 准备全新卷 → 把正确版本的备份恢复到新库 → 迁移 → 启动 → 检查账号、目标、任务 → 在 `.env` 固化新卷名。每一步失败就停；旧卷始终保留。

本教程统一使用 sudo，切换恢复卷时不要只依赖 `export` 被 sudo 继承。先记录旧 `.env` 中的卷名，在私密编辑器中把 `GOAL_COACH_DATA_VOLUME` 改成**已确认不存在的全新名字**，例如 `goal-coach-restore-20260924-a`，再执行 Compose。确认新名字不存在可用 `sudo docker volume inspect goal-coach-restore-20260924-a`；只有明确“no such volume”才表示不存在，连接/权限错误不算。

备份若来自宿主机只读挂载，容器内 UID 1000 必须有读取权限。不要 `chmod 777`：将**选中的一个备份**复制进新建的专用恢复输入目录，由维护者核对拥有者/权限后授予 UID 1000 只读，再以 `:ro` 挂载。下例仅适用于已经停服、备份路径已确认、源不是链接的恢复演练：

```bash
sudo docker compose stop caddy app
install -d -m 0700 restore-input
# 将实际备份名替换后执行；input.db 必须不存在
test ! -e restore-input/input.db || { echo '恢复输入已存在，停止'; exit 1; }
sudo install -o 1000 -g 1000 -m 0400 backups/实际备份文件名.db restore-input/input.db
sudo chown 1000:1000 restore-input
sudo chmod 0500 restore-input
```

然后**私下编辑 `.env` 切换到已确认不存在的新卷名**，检查并恢复：

```bash
sudo docker compose config --quiet
sudo docker compose run --rm --no-deps -v "$PWD/restore-input:/restore-input:ro" app pnpm db:restore -- /restore-input/input.db /app/data/goal-coach.db
sudo docker compose run --rm --no-deps app pnpm db:migrate
sudo docker compose up -d --no-build
sudo docker compose ps
```

命令逐条检查，不一口气执行。`db:restore` 拒绝覆盖已有目标；不要为了让它通过而删除旧目标。不要复制旧 WAL/SHM 到新库。恢复的是备份时间点状态，之后的任务、账号、配额变化不会自动回来；遇到安全事故还要重置受影响密码和撤销邀请。

### 14.2 重启持久化检查

在维护窗口先备份，确认没有正在执行的模型回合；正常 `sudo docker compose restart app` 后重新登录，确认刚创建的合成目标和任务仍存在。随后在计划好的服务器重启窗口检查 Docker 自启动、HTTPS 和数据保留。朋友正在使用时不突然重启。

### 14.3 升级与回滚

新版本用新的 release 目录和新的镜像标签，不覆盖旧镜像；同一时间只启用一套本项目服务。升级前备份，先在独立卷演练迁移和新版本。回滚需要匹配旧程序的**升级前备份 + 旧镜像 + 旧配置**，恢复到新卷；不能把旧程序直接连到已迁移的新库。

禁止为了“清干净”执行 `docker compose down -v`、`docker volume prune` 或 `docker system prune --volumes`。它们可能删掉数据库/证书卷。普通停止用 `compose stop`。特别是 0.1.0 没有邀请认证，不能回滚到公网使用。[Compose down 的卷行为](https://docs.docker.com/reference/cli/docker/compose/down/)。

## 15. 常见问题：按现象检查

| 现象 | 先检查 | 不要这样做 |
| --- | --- | --- |
| 本机“未配置 Key” | 准确 `.env.local` 路径、Ctrl+S、扩展名、变量名、同名进程环境 | 把 Key 发到聊天 |
| 本机仍用预设流程 | 是否旧服务；设置页是否保存了 mock；新版是否已重启 | 只修改文件就认定服务自动更新 |
| 模型认证失败/401 | Key 是否有效或撤销、使用了哪个账户 | 在日志输出 Authorization |
| 余额不足/402 | DeepSeek 平台余额与用量 | 无限重试 |
| 429/超时 | 配额、并发、供应商状态、网络；先等已发送请求结算 | 不明结果立即新建多次回合 |
| ECS SSH 超时 | 公网 IP、22 的来源规则、你公网 IP 是否变化 | 把所有端口永久开放 |
| Workbench 不通 | 连接方式及官方来源规则，不是电脑 IP 规则 | 放弃身份校验或公开私钥 |
| 构建被 killed/137 | 主机内存、磁盘、内核 OOM；减少并行，必要时调整资源 | 无依据更新全部依赖 |
| 原生 SQLite 构建失败 | 锁定镜像、下载网络、构建日志中的第一处错误 | 复制 Windows node_modules 到 Linux |
| app unhealthy | `compose logs --tail=80 app`，迁移、选中模型配置、数据库卷权限 | 把应用改成 root 或 chmod 777 |
| HTTPS 证书失败 | A/AAAA、80/443、防火墙、已有占用、Caddy 日志 | 忽略证书警告 |
| 502 | app 是否 healthy，Caddy 与 app 网络、模型请求是否超时 | 公开 3000 绕过代理 |
| 登录/写操作 403 | 访问域名与 APP_ORIGIN 是否完全一致、HTTPS、Cookie、使用正确账号 | 关闭 Origin/身份校验 |
| 数据“消失” | 是否更换卷名、数据库路径、账号或端口 | 删除所有卷后重装 |
| 手机没有安装按钮 | 系统浏览器、HTTPS、站点已安装与否、平台菜单 | 把 HTTP 访问当正式 PWA |
| 备份/恢复权限失败 | 源和目标路径、UID 1000、只读输入与全新目标 | 覆盖原库或共享所有备份 |

查看日志只能在私密终端，分享前脱敏；不要启用记录整个请求/响应、Cookie 和 Key 的调试。当前没有已验证的崩溃后 Agent 自动续跑保证，发现中断回合先核对状态/审计和已发生变更，再处理，不手工改数据库标记为成功。

## 16. 给朋友试用之前的验收单

只有对应项实际完成才打勾，不把本机结果填到服务器栏。

- [ ] 自己克隆的版本在本机能启动；已核对历史真实调用记录及其未覆盖项（2026-09-27 报告不是本次服务器通过证明）。
- [ ] Linux 镜像成功构建，记录实际镜像 ID/基础镜像 digest；非 root 用户可写数据库卷。
- [ ] 域名 HTTPS 有效，未开放 app 3000；唯一 APP_ORIGIN 正确。
- [ ] 管理员与两个成员账号注册、登录、退出、隔离、撤销邀请/禁用均正确。
- [ ] DeepSeek 用户同意与撤回正确；无同意时不发模型请求，但手动操作仍可用。
- [ ] 草案须确认才成为正式目标/计划；任务操作、统一撤销、复盘与刷新读回一致。
- [ ] 模型错误、配额耗尽、超时均有可理解反馈，不产生未经确认的破坏性写入。
- [ ] 容器/服务器重启后数据保留；新卷恢复演练通过，至少一份加密离机备份可恢复。
- [ ] 至少一台 iPhone 和一台 Android 按目标用户设备验证；未测的平台明确标注未测。
- [ ] 阿里云/模型费用观察和人工暂停流程明确，不承诺不存在的全站硬封顶。
- [ ] 隐私说明、服务范围、运营者联系渠道、数据保留/删除及适用合规要求已处理。

## 17. “有价值”与“可收费”不是同一验收

首批建议邀请 3–5 位朋友，先围绕学习和轻工作目标试用一周。每个人选择一个可完成的小目标，记录是否能在十分钟内形成自己认可的下一步、建议是否符合可用时间、是否愿意第二天继续、哪些地方仍需大量手改。征得同意再收集反馈，不把私密目标批量传给模型做“统计”。

这些是建议的试用指标，不是目前已经取得的商业成绩。上线前还需补齐或验证全站成本告警/暂停、故障恢复、持续备份、隐私服务说明、内容边界和安全响应；收费、开放注册、支付与应用商店上架不属于本版已交付范围。缺少这些不能宣称“商业就绪”。

2026-09-27 依赖检查还记录了 1 项开发工具链 esbuild 的中风险公告；生产依赖查询未报已知漏洞，但 Docker 模板保留完整工具依赖，不能由此推断镜像“零风险”。当前启动路径不使用该 esbuild 开发服务器，禁止为排错在生产开启开发/Studio 服务；已知风险、来源与后续依赖维护要求见[全量验收记录的依赖安全节](../delivery/full-acceptance-2026-09-27.md#依赖安全查询2026-09-27-0635-utc)。不自行修改锁文件或使用强制升级。

香港源站与大陆源站的 ICP 接入要求不同，但香港不是全面免责。阿里云说明：大陆服务器需要 ICP 备案，境外服务器不因该托管位置要求相同的 ICP 接入备案；面向大陆用户还提示公安备案等要求。使用大陆 CDN/ESA 又有不同前提。应按运营主体、服务对象、AI 内容、数据处理与地区要求向接入商/主管部门核实，不能用本教程代替法律意见。[阿里云网站 ICP 场景](https://www.alibabacloud.com/help/en/icp-filing/basic-icp-service/product-overview/icp-filing-requirements-for-a-regular-website)、[CDN 加速地域](https://www.alibabacloud.com/help/en/cdn/user-guide/change-the-accelerated-region)。

## 18. 以后每天/每次升级怎么维护

每天早期试用期：检查服务是否可达、容器健康、余额/异常用量、磁盘和备份成功情况；不用阅读朋友的私人对话来判断服务是否活着。

每次改 Key/模型/额度：私下编辑 `.env` → 静默配置检查 → 重建 app 容器 → 健康检查 → 小额授权业务检查。更换提供方后用户需重新同意。

每次升级：保留旧源码和镜像 → 新备份 → 独立环境演练 → 维护窗口切换 → 检查 → 保留可恢复旧卷。不要在用户数据上调试迁移。

若忘记管理员密码，不重复 bootstrap；使用[运维手册的 stdin 密码重置](operations.md)，避免密码落入命令参数和历史。服务器凭据泄露、Key 泄露、数据库损坏是不同事故，分别处理。

官方依据与边界详见[本次资料核验笔记](../research/2026-09-24-aliyun-hong-kong-docker-sources.md)。
