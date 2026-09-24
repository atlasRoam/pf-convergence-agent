# RPC 模式

`agentcore --mode rpc` 启动标准输入/输出上的本地 JSON 消息协议；独立入口也提供 `./rpc-entry` 导出（对应 `dist/bundle/rpc-entry.js`）。主进程需保持 stdio 通道，不要把日志或凭据写入协议输出。RPC 支持会话消息、状态和命令，实际字段、错误与事件以 `src/modes/rpc/` 和测试为准。

仓库根包装器同样可传 `--mode rpc`，并继续使用固定的 `runtime/` cwd 和显式产品资源；直接包入口不会继承这些保护。`--mode json` 是独立的单向事件流模式，不是 RPC；`--print` 是非交互文本模式。使用真实 Provider 前应在受控环境配置凭据。
