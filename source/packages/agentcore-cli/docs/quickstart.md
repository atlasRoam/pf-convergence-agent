# 快速开始

需要 Node.js >=22.19.0 和 npm。在仓库 `source/` 使用锁文件准备依赖：`npm ci --ignore-scripts`。随后从仓库根运行 `./start.ps1 --help`（PowerShell）或 `./start.sh --help`（Bash）；日常运行去掉 `--help`。在 Windows 验证机操作安装、构建和测试；不要在 Linux/VPS 上执行构建。

根脚本将工作目录设为 `runtime/`，使用 `AGENTCORE_*` 环境变量继续指向既有 `runtime/.agent/` 配置和会话，以保留用户模型、凭据与历史；它不自动合并、迁移或删除 `.agentcore`。根入口禁用普通自动资源发现，仅加载 PFNT 4.6 Skill 与凭据防护扩展。需要模型调用时，由操作者在受控环境配置所选 [Provider](providers.md)，不要把密钥放入仓库或对话记录。`--version` 与 `--list-models` 可以检查当前源码入口和已配置模型；后者不代表在线目录。

直接运行包的 `agentcore` 入口适合独立 CLI/SDK 集成，不会自动设置 `runtime/` cwd、隔离目录或加载产品资源；参见 [安全边界](security.md)。
