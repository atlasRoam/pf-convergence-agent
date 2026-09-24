# Windows

Windows 是本源码候选的实际构建/验收平台。准备 Node.js >=22.19.0、npm，并在 `source/` 依锁文件运行 `npm ci --ignore-scripts`；从仓库根通过 PowerShell 执行 `./start.ps1`。完整编译、打包和运行验证以仓库外层的 `docs/agentCore-Windows验证清单.md` 为准，不能用 Linux/VPS 代跑。

可在 [配置](settings.md) 的 `defaultTools` 中选 `powershell` 替代默认 `bash`；PowerShell 工具使用可用的 `pwsh.exe` 或 Windows PowerShell。若使用 `bash`，需可用的 Git Bash 或在 `shellPath` 设置解释器路径。PowerShell 启动脚本负责 cwd 与产品资源注入，而直接运行包的可执行入口不负责这些工作。
