# 百炼 Qwen 就绪性核查（2026-09-18）

范围：仅核对阿里云百炼官方文档所述的模型、OpenAI 兼容 Chat API 与地域接入要求；**未**读取任何密钥、环境变量，亦未实际调用模型。因此本文不构成对某个业务空间权限、配额或线上行为的保证。

## 结论

两个现有精确模型 ID 均是官方已列出的公开 ID，而非「未找到／无法证实」的名称：

| 已配置 ID | 官方证据 | 官方说明的能力 |
| --- | --- | --- |
| `qwen3.7-plus-2026-05-26` | [文本生成模型表](https://help.aliyun.com/zh/model-studio/text-generation-model) 将其列为 `qwen3.7-plus` 快照；[视觉模型表](https://help.aliyun.com/zh/model-studio/vision-model) 亦逐字列出该 ID。 | 1M 上下文、Function Calling、内置工具、结构化输出均为“支持”。 |
| `qwen3.7-flash-2026-07-15` | [文本生成模型表](https://help.aliyun.com/zh/model-studio/text-generation-model) 将其列为 `qwen3.7-flash` 快照；[视觉模型表](https://help.aliyun.com/zh/model-studio/vision-model) 亦逐字列出该 ID。 | 1M 上下文、Function Calling、内置工具、结构化输出均为“支持”。 |

所以，就所询问的模型标识本身，结论是**已验证为官方文档支持**。但文档表不能证明某个具体业务空间在某个地域已开通、API Key 被授权到这些模型，或配额足够；这些仍需在目标地域/业务空间做一次不含敏感信息的实际健康检查。

`qwen-plus` 与 `qwen-flash` 也仍是官方文档列出的别名／稳定模型（含快照版本），且模型表标为支持 Function Calling 与结构化输出；它们不是可假定与 Qwen3.7 快照在能力、上下文或默认思考行为完全等价的替代项。见[文本生成模型表](https://help.aliyun.com/zh/model-studio/text-generation-model)与[深度思考模型说明](https://help.aliyun.com/zh/model-studio/deep-thinking)。

## 与当前客户端调用方式的对应关系

- 百炼明确提供 Node.js `new OpenAI({ apiKey, baseURL })` 加 `openai.chat.completions.create(...)` 的示例，故 OpenAI JS 的非流式 Chat Completions 调用模式本身得到文档支持。[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- 两个选定 Qwen3.7 快照均支持 Function Calling。`tools` 为 Chat API 的可选参数；`tool_choice` 的默认值即 `auto`，而 `auto` 表示由模型自行选择工具。因此当前的 `tools` + `tool_choice: "auto"` 用法符合文档，不能据此判定为阻断项。注意 Qwen 不支持可靠的 `tool_choice: "required"`，思考模式下也不支持强制指定某一个函数。[Chat 参数说明](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- `response_format` 也是可选项，缺省为 `{"type":"text"}`；`{"type":"json_object"}` 为官方支持的选项，且提示词必须明确要求 JSON，否则请求会报错。两条目标模型官方表标记“结构化输出：支持”。因此，当前未传 `response_format` **不是接口必然拒绝的证据**，但若业务逻辑需要机器可解析的稳定 JSON，应显式传 `response_format: { type: "json_object" }` 并在提示词要求 JSON（或改用 `json_schema`）。这是一项部署前兼容性验证／稳健性改进，而非仅凭文档即可断言的现有故障。[Chat 参数说明](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- `enable_thinking` 同样是可选参数，Qwen3.7 支持 `true`/`false`。但官方“深度思考”清单明确说这两个精确 Qwen3.7 快照是**混合思考、默认开启**。故不传该参数不是 API 请求格式错误，却会采用思考默认值，影响延迟、Token/费用及返回中是否带 `reasoning_content`。对于目标是普通结构化教练回复、工具轮次稳定性或可预测成本的部署，应显式设置 `enable_thinking: false`；它是有依据的配置改进，不能仅据此宣称当前首轮调用必然失败。OpenAI SDK 中该非标准字段应按所用 SDK 的扩展字段方式传递（官方 Python 示例用 `extra_body`；直接 HTTP 放请求体顶层）。应以当前 Node SDK 的透传方式做实测确认。[深度思考模型说明](https://help.aliyun.com/zh/model-studio/deep-thinking)；[Chat 参数说明](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- `max_tokens`/`max_completion_tokens` 均为可选；不传并非已知 API 阻断。官方建议新接入使用 `max_completion_tokens`，并说明其适用于 Qwen3.7 Max、Qwen3.5+ Plus、Qwen3.5+ Flash 等范围，覆盖所选 Plus/Flash 系列。是否要在应用中设置上限是成本与响应长度控制问题，应在健康检查中验证，而不是把遗漏直接归因为不可部署。[Chat 参数说明](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)

## Base URL 与 API Key 必须配对

官方要求各地域的接入域名、API Key 与模型列表彼此独立，**不可跨地域混用**。生产推荐业务空间专属域名，且该域名要求属于目标业务空间的 API Key；否则会鉴权失败。官方 Base URL 总览也明确称 API Key 与 Base URL／计费计划不匹配会返回 401。

| 地域 | OpenAI-compatible `baseURL` |
| --- | --- |
| 北京 | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| 新加坡 | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| 美国（弗吉尼亚） | `https://{WorkspaceId}.us-east-1.maas.aliyuncs.com/compatible-mode/v1` |
| 德国（法兰克福） | `https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1` |
| 日本（东京） | `https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| 中国香港 | `https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1` |

来源：[OpenAI 兼容 Chat 的地域 URL](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[地域、业务空间与域名](https://help.aliyun.com/zh/model-studio/regions/)、[Base URL 总览（英文官方文档）](https://help.aliyun.com/en/model-studio/base-url)。共享 DashScope 域名仍可用于存量兼容；官方建议生产迁移到业务空间专属域名，并称共享 `dashscope.aliyuncs.com` 自 2026-09-30 起不再支持新特性。

## 谨慎的上线判定与最小验证

**不是“开箱即用即可保证上线”**：模型和协议能力已验证，但当前部署仍必须确认实际运行进程没有用空值覆盖环境中的 API Key/Base URL，并以同一地域、同一业务空间的 Key 与专属 URL 启动干净进程。现有配置若把模型 ID 设计为枚举／字面量，应保留两个已验证 ID，或先改校验后再尝试 `qwen-plus`／`qwen-flash`，不能只改环境变量就假定会生效。

建议在不记录或输出密钥的前提下，部署前做三项最小黑盒验证：

1. 以目标地域的 Key 和对应 `baseURL` 发一条非流式 `chat.completions` 文本请求，分别覆盖两个快照 ID；失败时保存 HTTP 状态码和请求 ID，不保存 Authorization 内容。
2. 以一个最小 JSON Schema 工具验证 `tools` 与 `tool_choice: "auto"` 的 `tool_calls`／工具结果续轮；不要测试 `required`。
3. 对需要结构化持久化的路径，验证 `response_format: { type: "json_object" }` 加明确 JSON 指令，及 `enable_thinking: false` 的 Node SDK 请求透传和响应解析。

这三项通过后，才能将“官方 API 能力支持”升级为“该业务空间的应用就绪”。
