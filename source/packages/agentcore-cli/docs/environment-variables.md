# 环境变量

根 `start.sh` / `start.ps1` 设置 `AGENTCORE_AGENT_DIR=runtime/.agent`、`AGENTCORE_SESSION_DIR=runtime/.agent/sessions`、`AGENTCORE_RUNTIME_CWD=runtime`、`AGENTCORE_OFFLINE=1`、`AGENTCORE_TELEMETRY=0`（均为对应的绝对路径或值），以继续使用既有私有数据根。Windows `start.ps1` 还会将这些路径及可用的项目 `PFSAA_PYTHON` 合并到 `WSLENV`，让系统选择 `bash.exe` 时仍能在 WSL 侧得到同一 runtime 和已核 Python。直接运行包入口时不会自动设置这些值；未覆盖时配置默认位于用户主目录的 `.agentcore/agent/`。

`AGENTCORE_AGENT_DIR` 指定 `auth.json`、`models.json` 和 `settings.json` 的父目录；`AGENTCORE_SESSION_DIR` 指定会话目录，`--session-dir` 可覆盖。`AGENTCORE_OFFLINE=1` 禁用启动阶段联网操作，不阻断操作者主动发起的 Provider 请求。`AGENTCORE_TELEMETRY` 控制安装遥测设置。Provider 凭据名称因实现而异，如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 和 `GEMINI_API_KEY`；只在受控环境设置，不写入本文档。

CLI/RPC 入口设置进程标记 `AI_AGENT=agentCore` 和 `AGENTCORE_CODING_AGENT=true`。内置 `bash`/`powershell` 工具的子进程按执行时的会话状态注入 `AGENTCORE_SESSION_ID`、`AGENTCORE_SESSION_FILE`（临时会话可缺省）、`AGENTCORE_PROVIDER`、`AGENTCORE_MODEL`、`AGENTCORE_REASONING_LEVEL`。自定义工具用 `createBashTool`/`createPowerShellTool` 时默认启用该注入，可通过 `exposeSessionEnvironment` 关闭；用户手动 shell 命令与 SDK 进程本身不保证收到会话字段。不要把这些字段当作凭据或权限证明。
