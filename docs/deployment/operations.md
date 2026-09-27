# 邀请版运维

接入状态与现场步骤以[全量验收记录](../delivery/full-acceptance-2026-09-27.md)和[香港 Docker 教程](aliyun-hong-kong-docker-beginner.zh-CN.md)为准。本页保留底层维护说明；若使用 `sudo docker`，恢复卷选择按新教程私下编辑 `.env`，不要假定 sudo 会继承 shell 的 `export`。

以下容器命令在源码根目录、已配置私密 `.env` 的目标 Linux 主机执行。本开发机未安装 Docker/WSL；容器命令和卷恢复流程尚待目标环境验收。所有维护路径必须为运营者拥有的目录，不能使用共享可写临时目录、符号链接或不明卷。备份包含账号凭证哈希、会话及业务数据，应加密离机保存并限制权限，不能提交 Git、发到聊天或附进源码包。

## 备份

`db:backup` 必须显式取得环境中的 `DATABASE_PATH`，不读取 `.env.local`；目标目录必须已存在，目标文件必须不存在。它通过 SQLite backup API 包含已提交 WAL 数据，只把脚本拥有的临时快照转为 DELETE 回滚日志模式，关闭后再只读执行 integrity_check 和 foreign_key_check；发布的是无需 WAL/SHM 旁路文件的自包含数据库，源库继续使用原来的 WAL 模式。空库、损坏库和有外键违规的源均拒绝。通过同目录受控临时目录和硬链接独占发布，不覆盖原有路径，也不删除调用者的失败目标。需支持硬链接的本地文件系统（如 NTFS/ext4），不支持时返回失败而不降低防覆盖保证。

```sh
# 每次选择新的文件名；此命令可以在 app 运行时执行。
sudo docker compose exec app pnpm db:backup -- /app/data/backup-20260919-1600.db
# 宿主目录应预先创建为仅维护者可读写；新目标不能已经存在。
test ! -e backups/backup-20260919-1600.db && \
  sudo docker compose cp app:/app/data/backup-20260919-1600.db ./backups/backup-20260919-1600.db && \
  sudo chown "$(id -u):$(id -g)" ./backups/backup-20260919-1600.db && \
  chmod 600 ./backups/backup-20260919-1600.db
```

第二条检查失败时立即停止，不运行后续复制。把备份复制到受控离机存储后校验哈希、记录时间、应用版本和迁移版本，并定期做恢复演练。在线备份无需复制 WAL/SHM；不要用普通 `cp goal-coach.db` 替代它。操作系统突然崩溃/磁盘失效仍需备份策略支持。脚本异常中断可能遗留 `.goal-coach-snapshot-*` 临时目录；先证明没有维护进程，再由管理员人工核对清理，不运行广泛通配删除。

本机源码维护可先在 PowerShell 设置 `$env:DATABASE_PATH='D:\明确目录\goal-coach.db'`，再执行 `pnpm db:backup -- D:\备份目录\新文件.db`。成功消息不会回显路径或数据。第一次迁移前如库尚未存在，则无数据库可备份；不要以空文件冒充备份。

## 恢复到全新卷（应用必须停止）

1. 记录当前镜像 tag/digest、原 `GOAL_COACH_DATA_VOLUME` 名称及配置，在停止前完成一次新的备份。执行 `sudo docker compose stop caddy app`，确保无本项目写入进程。禁止 `down -v`，保留旧卷。
2. 选择一个从未使用过的卷名；不要复用旧卷或覆盖原库。下面名称仅为格式示例，先执行 `sudo docker volume inspect goal-coach-restore-20260919-1600`，确认错误确实为该卷不存在，而非 Docker 服务/权限错误。存在则另选新名字。在私密 `.env` 中将 `GOAL_COACH_DATA_VOLUME` 改为该新名字；不要仅用 shell 的 export，因为 sudo 通常不继承它。然后执行：

先按[香港教程第 14.1 节](aliyun-hong-kong-docker-beginner.zh-CN.md#141-恢复演练必须真的做)将**选中的一个备份**复制为新建 `restore-input/input.db`，并核对目录归 UID/GID 1000、权限 0500，文件归 UID/GID 1000、权限 0400；源路径不能为链接。不要直接挂载维护者私有的整个 `backups/`，维护者 UID 可能不是 1000，容器会无法读取。下面命令以该准备已成功为前提。

```sh
sudo docker compose config --quiet
sudo docker compose run --rm --no-deps -v "$PWD/restore-input:/restore-input:ro" app \
  pnpm db:restore -- /restore-input/input.db /app/data/goal-coach.db
sudo docker compose run --rm --no-deps app pnpm db:migrate
```

3. 每条命令非零时停止。`db:restore -- <backup> <new-db-path>` 会只读验证备份，使用同样的 SQLite snapshot/独占发布；目标已存在（包括同源文件或链接）时拒绝并保留字节。不要恢复备份的 WAL/SHM 到这个新路径，也不要在服务运行时切库。脚本本身无法证明其他进程已停，停服是操作前提。
4. 用兼容此备份 schema 的同版或更新版镜像启动 `sudo docker compose up -d --no-build`，检查健康、登录和只读目标列表。保持私密 `.env` 中的新卷名，不要在下一次启动时切回旧卷。原卷持续保留，按已批准的保留策略日后处理。

恢复会恢复备份时的账号、会话和配额状态，备份后的变化将不存在；如涉及凭证事故，启动前用密码重置使对应会话失效，并在账号管理撤销旧邀请。演练必须使用合成/已授权数据。

### 目标 Linux 主机的只读挂载验收

Windows 合成测试使用 NTFS ACL 对输入目录创建文件、对备份文件写入实施实际拒绝，并验证恢复成功；它不等于 Linux `:ro` 挂载验证。以下演练须在已构建修复后镜像的 Linux 主机，以有 sudo 权限的非 root 维护用户执行。与新手教程一致，不要求加入 docker 组；sudo 仅用于访问 Docker，容器仍用当前维护者的非 root UID/GID。每条命令失败立即停止；仅创建临时合成数据，不挂接 Compose 的应用卷，不读取部署环境文件，不调用模型。

```sh
test "$(id -u)" -ne 0 || { echo '请使用非 root 维护用户'; exit 1; }
acceptance_dir="$(mktemp -d -t goal-coach-ro-acceptance.XXXXXXXX)"
mkdir "$acceptance_dir/input" "$acceptance_dir/output"
sudo docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint node \
  -v "$acceptance_dir:/accept" goal-coach-agent:0.2.2 -e '
const DB=require("better-sqlite3"), {execFileSync}=require("node:child_process");
const db=new DB("/accept/source.db");
try {
  db.pragma("journal_mode=WAL");
  db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY); INSERT INTO sample VALUES(7)");
  execFileSync(process.execPath,["scripts/database-backup.mjs","/accept/input/backup.db"],
    {env:{...process.env,DATABASE_PATH:"/accept/source.db"},stdio:"inherit"});
} finally { db.close(); }'
sudo docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint node \
  -v "$acceptance_dir/input:/input:ro" -v "$acceptance_dir/output:/output" \
  goal-coach-agent:0.2.2 -e '
const assert=require("node:assert/strict"), fs=require("node:fs"), DB=require("better-sqlite3");
assert.throws(()=>fs.writeFileSync("/input/write-probe","must fail"),e=>["EROFS","EACCES","EPERM"].includes(e.code));
require("node:child_process").execFileSync(process.execPath,
  ["scripts/database-restore.mjs","/input/backup.db","/output/restored.db"],{stdio:"inherit"});
const db=new DB("/output/restored.db",{readonly:true,fileMustExist:true});
try {
  assert.deepEqual(db.prepare("SELECT id FROM sample").all(),[{id:7}]);
  assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  assert.deepEqual(db.pragma("foreign_key_check"),[]);
} finally { db.close(); }
assert.deepEqual(fs.readdirSync("/input"),["backup.db"]);
assert.deepEqual(fs.readdirSync("/output"),["restored.db"]);
console.log("只读挂载恢复验收通过");'
```

记录镜像 digest、退出码和验收结果，保留该临时目录供核对；清理时先确认它确实是本次生成的准确目录。上述 Linux 演练在当前 Windows 开发机未执行。

## 管理员恢复、禁用和撤销

管理员可在“账号管理”禁用成员/其他管理员和撤销未使用邀请。禁用或重置密码会立即使该账号所有会话失效；最后一个启用管理员不能被禁用。bootstrap 只用于没有管理员且没有有效管理员邀请的初始系统，不能作为管理员密码绕过。管理员邀请过期 72 小时后、仍无管理员时可重新 bootstrap。

忘记密码由拥有服务器维护权限的人在私密 Linux Bash 终端执行；新密码仅经 stdin，不在命令参数或 shell 历史中：

```bash
sudo -v
read -r -p '需要重置的账号名: ' reset_username
read -r -s -p '新密码: ' reset_password
printf '\n'
printf '%s' "$reset_password" | sudo -n docker compose exec -T app pnpm auth:admin reset-password "$reset_username"
unset reset_password reset_username
```

先确认 sudo 验证成功，再填写准确账号名。`sudo -n` 避免 sudo 在密码管道中交互读取；如 sudo 会话失效，命令会失败，先重新验证 sudo 后再私下重试。CLI 拒绝命令行密码参数、会回显的交互 TTY 和过大输入；用户名之外不打印秘密。共享屏幕/录屏关闭后再生成和传递邀请，绝不把 token 放在 URL。

## 升级和回滚

升级前备份到新文件，记录当前镜像和迁移版本，停 Caddy/app 后用新源码 frozen lockfile 构建新的不可混淆镜像标签，再启动并验证。`GOAL_COACH_IMAGE` 可指定已审核版本；不要覆盖旧镜像标签或清除旧卷。部署前后的变更在独立卷合成数据演练。

不能把旧程序直接连接已迁移的新数据库，也不能手工删除迁移表来“降级”。旧程序可能不识别持久化的 `provider=deepseek`；即使 schema 兼容，也不能仅凭镜像替换认定可回滚。回滚须停止应用，把匹配旧版的升级前备份恢复到全新卷，使用对应旧镜像与旧私密配置并演练；备份后的数据变化需另外核对和处理。原迁移后卷仍保留以供后续恢复，禁止 `docker compose down -v`。0.1.0 是无认证本机版本，不能当作可公开的邀请版回滚镜像。

## 诊断与源代码转交

`docker compose ps` 展示进程状态，容器内 `/api/health` 检查本地配置及只读数据库连通性（不可用返回安全 503），`pnpm deployment:check` 只校验所选供应商配置；均不发起模型请求，也不证明 DeepSeek 或 Qwen 可用。避免开启包含请求体、响应体、cookie、Key 或邀请凭证的调试日志。不要反复重试未知写入或把带秘密的诊断输出发到聊天。同步回合的幂等/未知结果处理不等于进程崩溃后能自动续跑；目标主机须单独演练并制定人工处置步骤。

完成最终验收和审查后运行 `pnpm package:source`，按当前 package.json 版本创建全新的源码目录（0.2.2 为 `dist/goal-coach-agent-source-v0.2.2`）和 SHA-256 清单；实际生成状态以最终交付回执为准。目标已存在时拒绝覆盖，历史目录/ZIP 也不覆盖。白名单包含容器配置、迁移、维护脚本和邀请验收入口；环境文件只允许根 `.env.example` 与精确的 `deploy/.env.example`，不包含任意嵌套 `.env*`、数据库、日志、用户导出、依赖或构建。生成的是目录而非 ZIP；转交前核对实际目录与 manifest，私密 `.env`、备份和证书必须通过独立受控渠道处理。
