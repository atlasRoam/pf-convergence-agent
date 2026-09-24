# 模型配置

内置模型来源于 `@pfsaa/ai` 的随源码数据；不会在启动时从产品远程目录自动更新。自定义模型配置文件在 `AGENTCORE_AGENT_DIR/models.json`，独立入口的默认配置根为用户主目录 `.agentcore/agent/`。文件可定义 Provider/模型及兼容参数，具体 schema 以 `src/core/model-config.ts` 为准；勿将生产密钥写入示例。

`--list-models [search]` 列出本地可用模型；`--provider`、`--model` 选择本次运行目标，`--models <patterns>` 限制交互模式下的循环列表。模型 ID 及可用性取决于本机配置和凭据，不保证某个第三方模型一直在线。参见 [Provider](providers.md)。
