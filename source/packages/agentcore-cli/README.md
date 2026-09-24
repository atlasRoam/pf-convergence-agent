# @pfsaa/agentcore-cli

PFSAA 的 `agentcore` CLI/TUI，源码版本 1.0.0，Windows 构建与定向测试待验证。产品入口为仓库根的 `start.ps1` 与 `start.sh`；从根入口启动会固定 `runtime/` cwd，并保留既有 `runtime/.agent` 配置与会话（`runtime/.agent/sessions`）。`source/.agentcore` 仅是产品资源命名；根入口不自动合并、迁移或删除 `runtime/.agentcore`。根入口显式启用 `compute-engine` 路由 Skill、`powerflow-manual-adjustment` 共享方法 Skill 和凭据防护。直接执行本包不自动提供上述产品保护。

命令行支持 `--help`、`--version`、交互会话、`--mode json|rpc`、`--export` 本地导出；`update` 只针对已配置的扩展来源，不更新程序或模型目录。产品不发布 npm 包、在线分享入口或自更新服务。

详情见 [当前文档](docs/index.md) 和 [Windows 用法](docs/windows.md)。在源码仓库中，项目说明位于根 `README.md`，验收步骤位于外层 `docs/agentCore-Windows验证清单.md`。源码示例不随 CLI 打包，不代表本产品支持上游在线服务。
