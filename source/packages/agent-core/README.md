# @pfsaa/agent-core

PFSAA 的 agentCore：处理消息、工具调用、事件和持久化会话的底层运行时。首方版本 1.0.0；此轮 Windows 构建尚待验证。普通产品使用者从仓库根 `start.ps1` / `start.sh` 启动 `agentcore`，无需单独安装本包。

该包不内置在线目录、安装器或自动更新。模型 Provider 通过 `@pfsaa/ai` 提供；持久化的 CLI JSONL v3、harness JSONL v4 和 SQLite 存储格式 1 是独立格式版本，不能随 npm 版本重置。

当前实现参考见 [docs/README.md](docs/README.md)；发布验收以仓库 [Windows 验证清单](../../../docs/agentCore-Windows验证清单.md) 为准。
