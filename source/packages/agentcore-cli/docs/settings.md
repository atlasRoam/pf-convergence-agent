# 配置

全局配置位于 `AGENTCORE_AGENT_DIR/settings.json`；未设置该变量的独立包入口默认使用用户主目录的 `.agentcore/agent/settings.json`。项目本地配置位于当前工作目录的 `.agentcore/settings.json`，其加载受项目信任机制约束。根包装器固定 cwd 为 `runtime/` 并禁用扩展、Skill、提示词模板与上下文文件的自动发现；这不等于直接包入口的默认行为。

常用键包括 `defaultProvider`、`defaultModel`、`defaultTools`、`shellPath`、`sessionDir`、`defaultProjectTrust`。例如在受信任环境中，`{"defaultTools":["read","powershell","edit","write"]}` 可使 Windows 模型工具优先使用 PowerShell；配置的其他键和类型以 `src/core/settings-manager.ts` 为准。会话目录也可由 `--session-dir` 指定。无需在文档或示例中填写真实 API 密钥，凭据优先由受控环境或专用认证存储提供。

`--approve` / `--no-approve` 只覆盖本次项目资源信任决策，不是进程沙箱。参见 [安全](security.md) 与 [环境变量](environment-variables.md)。
