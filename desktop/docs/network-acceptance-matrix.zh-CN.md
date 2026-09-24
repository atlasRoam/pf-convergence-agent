# PFSAA 网络验收矩阵

本矩阵验证真实的 PfsaaHost → AgentCore runtime → Provider 链路。它与仅验证 Renderer 设置回写的用例分开：每个通信方式都必须使用真实 GPT-5.5 请求，并把助手响应持久化到 AgentCore Session 后才算通过。

## 矩阵

| 编号 | AgentCore 设置 | 验证边界 | 通过条件 |
| --- | --- | --- | --- |
| N-01 | `auto` | AgentCore 自动选择通信方式 | 新 Session 选中已配置的 GPT-5.5，提示完成，并在 `sessions.messages` 中找到精确标记 |
| N-02 | `sse` | Server-Sent Events 请求/流 | 同上，且请求前读回设置值为 `sse` |
| N-03 | `websocket` | WebSocket 请求/流（非缓存上下文） | 同上，且请求前读回设置值为 `websocket`，持久化消息中不能出现 `provider_transport_failure` 回退诊断 |
| N-04 | `websocket-cached` | WebSocket 连接/上下文复用 | 同一 Session 连续完成两次提示，两次标记都写入 Session，且不能出现 `provider_transport_failure` 回退诊断 |
| N-05 | 隔离 | 凭据与设置安全 | 每格使用配置好的 AgentCore 目录临时副本和临时工作区，不写入用户真实 `settings.json`、Session 或凭据 |
| N-06 | 清理 | Session 生命周期 | 即使某格失败，也清理临时 Session、工作区、AgentCore 目录副本和 PfsaaHost 子进程 |

## 执行

先构建当前 PfsaaHost，再运行：

```text
npm run acceptance:network
```

脚本会查找恰好一个已认证、名称匹配 GPT-5.5 的模型。如果配置了多个 GPT-5.5，可用 `PFSAA_ACCEPTANCE_MODEL=provider/model` 明确指定；Provider 较慢时可提高 `PFSAA_ACCEPTANCE_TIMEOUT_MS`。

命令任一格失败都会以非零退出，并为每格输出一行 JSON。仅保存设置不会被判定为成功：必须同时满足 `agent.prompt` 返回 `completed`，且在持久化的 Session 消息中找到标记。

## 失败含义

- `settings.get` 不匹配：PfsaaHost 没有从 AgentCore 权威 SettingsManager 加载目标通信方式。
- 模型发现或 `agent.setModel` 失败：GPT-5.5 凭据/模型目录不可用，不会被降级成离线通过。
- 提示超时或报错：目标通信方式或 Provider 链路没有完成真实请求。
- 显式 WebSocket 出现回退诊断：AgentCore 实际走到了 SSE 回退路径，不能证明请求的 WebSocket 通信方式。
- 持久化失败：Provider 已返回，但 AgentCore Session 没有保留响应。

本矩阵补充 `npm run smoke:runtime`（IPC 与离线能力）、`npm run smoke:cli`（CLI 兼容性）以及可选的 CDP UI 设置验收；它不替代视觉界面检查。
