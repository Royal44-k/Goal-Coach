# Goal Coach DeepSeek + PWA 软件增量验证（2026-09-24）

本记录对应 `feat/local-goal-coach-mvp` 在 2026-09-24 的 Windows 本地软件验证。测试使用 Node.js 24.20.0、已锁定的 pnpm 11.19.0 依赖、合成配置、独立临时 SQLite 与受控 Edge 浏览器。没有读取 `.env.local`、真实 Key 或原练习数据库，没有请求真实模型，也没有更新正在使用的 3000 端口服务。本机窄屏与 PWA 浏览器测试不等于 iOS/Android 真机测试。

下表是本轮最终修复之前的历史基线证据；1019 个测试和 13/13 浏览器故事的数字不代表下文修复后的当前源码。最终完整回归由交付复核另行记录。

| 验证项 | 执行与结果 | 证据边界 |
| --- | --- | --- |
| 类型检查 | `node node_modules/@typescript/native/bin/tsc --noEmit`，退出 0 | 当前源码 TypeScript 检查 |
| Lint | `node node_modules/eslint/bin/eslint.js .`，退出 0 | 当前源码静态检查 |
| 单元/集成 | `node node_modules/vitest/vitest.mjs run`，85 文件、1019 测试通过，退出 0 | 合成环境；含 DeepSeek 配置、同意、假传输与部署/打包检查 |
| 固定案例 | `node --import tsx evals/run.ts --provider=mock`，30 例、0 崩溃、0 未批准结构写入、0 机器检查失败，退出 0 | 显式 mock、内存库、外网阻断；人工评分 `unassessed` |
| 本机浏览器 | `.../@playwright/test/cli.js test --config=playwright.config.ts`，13/13 Edge 故事通过，退出 0 | 白名单副本 `dist/goal-coach-pwa-preview-MqXVPh`，回环 3375、合成临时库；包含受控生产 build |
| 邀请与 PWA 浏览器 | `.../@playwright/test/cli.js test --config=playwright.invite.config.ts`，2/2 Edge 故事通过，退出 0 | 同一白名单副本，回环 3376、独立合成临时库；包括双账号隔离、静态离线缓存及受控生产 build |
| 独立生产 build | 在上述白名单副本执行 `node .../next/dist/bin/next build`，Next.js 16.3.4 编译、类型检查、13/13 静态页生成成功，退出 0 | 仅证明 Windows 上当前源码的 Next 构建，不是 Docker/Linux 镜像构建 |

浏览器全套初次运行曾失败：旧测试在新版按供应商和告知版本绑定的同意界面前继续操作；浏览器自动探测 `/favicon.ico` 得到 404；邀请/PWA 两个故事重复消费一次性管理员邀请码。逐项定位后，增设 favicon 到现有 SVG 图标的响应、让浏览器故事显式确认当前告知、复用合成管理员登录进行第二个故事，再重新运行完整套件取得上述通过结果。初次普通沙箱运行中，Windows 拒绝测试夹具关闭它自己的进程；准确 PID 15212 和回环端口 3374 随后检查均已不存在，没有广泛结束进程。最终浏览器测试在窄范围提权环境执行，其夹具通过进程所有权和端口检查完成安全关闭。

补充回归：独立审查发现仅选 `pwa.spec.ts` 时，前述管理员尚未由另一故事注册。全新白名单副本 `dist/goal-coach-pwa-preview-0aDHGp`、回环 3378 的单文件运行先复现该失败（1 failed，登录后找不到 `acceptance_admin`，退出 1）。修正为 PWA 故事先用合成凭据探测已有管理员；若不存在，则使用同一合成的一次性引导邀请自行通过界面注册。探测请求带精确回环 `Origin`，沿用原校验；没有改变生产认证、邀请码或请求守卫。修正源码副本 `dist/goal-coach-pwa-preview-x2gsKj` 在独立临时库和回环 3380 单文件运行 `1 passed (39.3s)`、退出 0；回环 3382 全邀请/PWA 运行 `2 passed (27.7s)`、退出 0。相同副本在 3381 的第一次全套重跑有 PWA 通过，但未修改的邀请故事记录一次 `/goals/<合成 ID> net::ERR_ABORTED` 请求失败，1 failed/1 passed；随后 3382 通过。原监听器只记路径和错误，关闭的 trace 没有请求类型/发起源证据，不能断言取消原因或声称已根治；作为间歇性测试观察项交综合审查。未扩大 console/network 过滤。

`MODEL_PROVIDER=mock` 为部署示例默认值；`DEEPSEEK_API_KEY` 留空，DeepSeek 地址为官方 `https://api.deepseek.com`。配置校验和 health 仅验证所选供应商配置以及本地只读数据库，不访问供应商。`eval:deepseek` 与旧 `eval:live` 必须显式追加 `--allow-live` 且选定最多 5 例，缺失时在私密环境加载、数据库、客户端与结果输出前拒绝。本批次未运行任何真实评测。源码包脚本的合成夹具验证了 SW、离线页、manifest 和三种图标进入 SHA-256 清单，并验证秘密/数据库排除、缺失资源拒绝以及旧目标不覆盖。本记录处于验证阶段、正式源码包生成之前；后续交付回执需单独写明实际源码提交、包路径和 manifest 哈希，本段不作为包已生成或始终未生成的声明。

最终修复复核：设置页在未同意 DeepSeek 时可直接切回 mock；本机与邀请账号可通过设置页撤回模型数据使用同意，而不清除数据或重置额度。已有批准任务和手动修改仍可访问，模型请求保持同意门槛。Android 内嵌浏览器无安装提示时显示系统浏览器/复制链接指引。邀请故事的请求失败诊断现记录安全的方法、资源类型、导航标记、测试阶段、序号和相对时间，并在失败时先附加诊断再关闭浏览器；先前 3381 的 `ERR_ABORTED` 原因仍未知。

修复后受影响的 8 个单元/集成文件：`node node_modules/vitest/vitest.mjs run` 加显式文件列表，117/117 通过、退出 0；`tsc --noEmit` 和更改文件 scoped ESLint 均退出 0。白名单生产副本 `dist/goal-coach-pwa-preview-QqZQHS` 使用空模型密钥、合成临时库、外网阻断：回环 3393 的本机 Edge 全套 14/14 通过、退出 0，包含新增 375px 未同意云供应商时切换回 mock 的故事；回环 3394 的邀请/PWA 全套 2/2 通过、退出 0，包含撤回同意后执行已批准任务且没有新模型请求。两套均在副本内生产构建，未触碰当前 3000 服务。3393 的早期普通沙箱单故事本身通过，但夹具关闭自有进程遭 Windows 拒绝，整体退出 1；精确 PID 10100 后经窄范围权限检查已不存在，合成临时目录 `goal-coach-e2e-bd36d37d-ae77-44b9-9fb4-1139351935dc` 被夹具按安全规则保留，没有强制清理。随后窄范围提权的完整浏览器运行正常关闭自有进程并退出 0。

部署边界：本机无 Docker、Podman、可用 WSL（`wsl.exe --status` 子退出码 50）。因此 `docker compose config --quiet`、Linux 原生 SQLite 构建/UID 1000 卷权限、Caddy/TLS、目标主机重启持久性和恢复演练均尚未实测。真实 DeepSeek 账户权限、余额、网络、工具闭环、质量和供应商账单也未实测。当前日 Token/并发限制不是人民币账单硬上限；没有全站费用告警/暂停管理或已验证的进程崩溃后回合自动恢复。原有 3000 服务未重启或升级，原练习库未备份/迁移/触碰，用户当前页面不会自动变成新版。启用时须先识别目标库、备份、迁移，再在其拥有者控制下重启并验证。

中国大陆邀请试用的主体、接入商和适用备案/登记、AI 内容标识仍是外部准入门槛。参考[工信部非经营性互联网信息服务办事指南](https://ythzxfw.miit.gov.cn/bssx/alx/dxhhlw/art/2025/art_88c400fc83904008bcf5b11bc08ec18f.html)、[网信办 2026-09-14 公告](https://www.cac.gov.cn/2026-09/14/c_1791136833136332.htm)与[AI 生成合成内容标识办法发布说明](https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm)。DeepSeek 地址和模型名参见[官方 API 入口](https://api-docs.deepseek.com/)；配置有效不等于真实模型可用，既有模型的备案也不自动覆盖本应用。不在本记录中给出具体主体的法律结论。

完整操作、备份与回滚边界见[中文指南](../deployment/full-guide.zh-CN.md)及[运维手册](../deployment/operations.md)。
