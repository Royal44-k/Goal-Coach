# 安全与隐私说明

请不要在公开Issue上传API Key、密码、Cookie、邀请码、.env、数据库、备份、用户目标或原始模型日志。发现疑似漏洞时，优先使用仓库Security页的私密报告入口（仅在所有者启用后可用）；如果没有入口，先联系所有者建立私密渠道，不公开利用细节或秘密。本仓库目前不承诺安全响应SLA。

## 配置与部署

- 默认mock；真实Key只存在本机或运营服务器环境，绝不放NEXT_PUBLIC_*。
- 本机仅回环；公网只invite+HTTPS。不要公开应用3000或SQLite文件。
- 明确按供应商同意；账号隔离、Origin、schema、版本、审批和配额不能为排错关闭。
- 数据导出与备份按敏感资料保管。不要在写入时普通复制.db；按运维手册在线备份、恢复到全新目标。
- PWA只缓存公开离线页，不缓存私人API或自动重放写请求。

## 已知边界（2026-09-27）

生产依赖审计当时未报已知公告；全依赖审计记录一项moderate：drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild@0.18.20，GHSA-67mh-4wv8-2f99，涉及开发服务器serve的CORS。Docker运行镜像保留运维工具依赖，不能据生产依赖审计声称镜像零风险。

现有入口未识别出esbuild serve调用，但这不是不可达证明。不要在生产启用该旧版开发服务器或Studio；需另行兼容性验证后维护依赖。[维护者公告](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)。

Linux容器、云端HTTPS、实体手机、生产压测和完整外部安全评估尚未完成。本应用没有模型输出绝对正确保证，也不是医疗、法律或投资决策产品。开放注册或收费前应完成相应安全、隐私与运营准入。
