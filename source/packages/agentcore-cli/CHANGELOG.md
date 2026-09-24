# agentCore CLI 变更记录

## 1.0.0（源码候选，未发布）

- 以 `@pfsaa/agentcore-cli` 和 `agentcore` 作为首方包及命令标识，配置使用 `.agentcore` 与 `AGENTCORE_*`。
- 仓库根包装器使用 `AGENTCORE_*` 身份，但为保持既有私有数据可用，将会话保留在 `runtime/.agent/`，显式加载 PFNT Skill 和凭据防护扩展。
- 保留本地交互、文本/JSON/RPC 模式、SDK、扩展及第三方模型 Provider 接口；不提供程序自更新、远程模型目录或会话分享服务。

Windows 打包及运行验收尚待验证；此记录不表示已经发布二进制或 npm 包。
