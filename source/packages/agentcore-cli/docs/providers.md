# Provider 与认证

`@pfsaa/ai` 保留正常第三方 Provider 接入；本地 CLI 可通过 `--provider <name> --model <id>` 或 `--model <provider>/<id>` 选择模型。实际可选项目由内置数据、`models.json`、扩展和本地认证状态决定；`--list-models` 只列当前可用模型，不查询远程产品目录。

认证可由相应 Provider 的环境变量、`AGENTCORE_AGENT_DIR/auth.json` 或 CLI 支持的登录流程提供。`agentcore auth check --provider <name>` 检查状态；`auth print-api-key`/`print-bearer-token` 会输出真实凭据，避免用于日志或文档。根包装器的 `AGENTCORE_OFFLINE=1` 限制启动联网，不代表对主动模型请求的离线模拟。PFNT 私有计算与第三方 Provider 认证是不同边界。

自定义 OpenAI 兼容端点可通过 [模型配置](models.md) 接入；底层 `pi-messages` 是外部自定义端点可能使用的 wire API 标识，不因产品改名而重写。
