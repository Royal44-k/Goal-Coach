# 从零安装与 DeepSeek 配置

适用于首次克隆本仓库的Windows用户。已有旧数据库时先备份，保留准确路径；本指南不要求删除旧目录、卸载软件或覆盖已有.env.local。Linux生产环境请用[Docker教程](../deployment/aliyun-hong-kong-docker-beginner.zh-CN.md)。

## 1. 准备与下载

准备Git、Node.js24.20.0、pnpm11.19.0；已有匹配版本无需重装。PowerShell逐段运行：

```powershell
node --version
git --version
pnpm --version
```

Node应为v24.20.0，pnpm为11.19.0。仅当pnpm未安装时，可在已有正确Node下执行 `npm install --global pnpm@11.19.0` 后重开终端核对。不要自动升级到latest，版本冲突先用 `where.exe node`、`where.exe pnpm.*` 检查路径。

```powershell
git clone https://github.com/Royal44-k/Goal-Coach.git
if ($LASTEXITCODE -ne 0) { throw '克隆失败，停止；已有同名目录时不要覆盖' }
Set-Location -LiteralPath './Goal-Coach' -ErrorAction Stop
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '安装失败，停止并查看第一处报错' }
```

没有Git时也可在仓库Code菜单下载ZIP并解压，进入含package.json的那一层。仓库没有node_modules或生产构建，不能直接双击运行。

## 2. 免费模式先启动

```powershell
if (-not (Test-Path -LiteralPath .env.local)) {
  Copy-Item -LiteralPath .env.example -Destination .env.local
}
pnpm db:migrate
if ($LASTEXITCODE -ne 0) { throw '迁移失败，停止' }
pnpm dev
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。默认mock不消耗模型余额；它是有限预设流程，不是任意自然语言Agent。免费完整体验见[原练习手册](../learning/free-practice.md)，实际日常目标建议配置真实模型。

默认数据库data/goal-coach.db，第一次创建新库是正常行为，不表示旧库被删除。若要沿用已有数据，先备份并在当前PowerShell明确设置 `$env:DATABASE_PATH = '你的完整数据库路径'`，再迁移。不要把旧库当测试数据。

若原生SQLite加载报错，确认Node版本、系统架构和锁文件一致；不要复制别人的node_modules或全部批准依赖构建脚本。现有pnpm-workspace.yaml刻意限制安装脚本。Docker路径会单独构建锁定SQLite原生模块；新Windows环境如缺少匹配二进制，需要依据准确报错准备受支持构建环境再单独处理，本仓库不保证所有新电脑无条件安装成功。

## 3. 私下填写DeepSeek

按Ctrl+C停止自己启动的开发服务，在本机编辑器打开.env.local，修改或补充以下项，不覆盖整个文件：

```dotenv
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=在本机填入自己的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_MAX_OUTPUT_TOKENS=4096
```

示例文字不能作为密钥；不要写NEXT_PUBLIC_*、不要发到聊天/Issue/截图，不提交.env.local。Key需有有效API余额。供应商控制台：[DeepSeek](https://platform.deepseek.com/api_keys)。Qwen接口仍保留，但使用其独立配置，不能共用Key。

重新运行 `pnpm dev`。打开“设置与数据”，确认DeepSeek选择与配置状态，阅读并确认该供应商的数据说明。如果数据库过去保存了mock选择，环境默认不会覆盖它，需在设置页切换；服务器邀请模式由运营者决定提供方。

“已配置”只表示本地配置有效，不代表联网调用已经成功；设置页检查本身不收费。正常发送给教练的消息和显式live评测会调用API并收费，避免盲目重试。

## 4. 开始使用与正常停止

按[使用手册](user-guide.zh-CN.md)走目标→草案→批准→任务→反馈→复盘。首次确认云端说明是你的正常授权，不是开发验收。

服务终端保持打开。Ctrl+C停止该终端启动的进程；不要结束所有node进程。关机后本机服务停止；127.0.0.1不能分享给朋友，手机跨设备访问请部署HTTPS邀请版。

## 5. 本机生产启动与PWA

先停止当前开发服务，确认目标库正确：

```powershell
pnpm build
if ($LASTEXITCODE -ne 0) { throw '生产构建失败，停止' }
pnpm local:check
if ($LASTEXITCODE -ne 0) { throw '启动预检失败，停止' }
pnpm local:start
```

仍打开3000。启动器核对版本、依赖、构建和端口，不安装依赖、不杀占用端口的进程。PWA在生产构建中启用；手机主屏安装请在自己的HTTPS部署上测试。私人数据不能离线操作。

## 6. 开发侧免费验证

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm eval
node --import tsx evals/lifecycle-run.ts --provider=mock
```

上述不应读真实模型Key或发付费请求。浏览器测试使用Edge、独立合成库，按[验收说明](../verification/local-mvp-acceptance.md)运行；不要在原用户数据库上执行测试清除操作。

真实评测只有在确认费用后手动运行。例如：

```powershell
node --import tsx evals/lifecycle-run.ts --provider=deepseek --allow-live --scenario=learning --replan-mode=confirm-more-time
```

这会生成新的合成案例，不保证与公开演示相同，也不会替用户实际学完TypeScript。不要把演示结果当成未来每次调用的承诺。
