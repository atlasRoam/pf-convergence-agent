# 会话与导出

根包装器为兼容既有用户数据，将会话存于 `runtime/.agent/sessions/`；直接包入口默认使用自己的 `AGENTCORE_AGENT_DIR` 下的 sessions 目录，除非指定 `AGENTCORE_SESSION_DIR` 或 `--session-dir`。会话文件可能包含用户输入、工具输出和敏感路径，请按私有数据处理。

`--continue` 接续最近会话；`--resume` 交互选择；`--session <path|id>` 打开指定文件或部分 ID；`--session-id <id>` 使用精确的项目会话 ID；`--fork <path|id>` 从已有会话创建分支；`--no-session` 不保存。`--export <file>` 将指定会话本地导出为 HTML，允许第二个参数作为输出路径。导出的 HTML 仍是敏感数据，不会被自动上传或分享。

CLI JSONL 会话格式与 agent-core harness 的持久化格式各自独立。版本与迁移以 `src/core/session-manager.ts` 和相关测试为准，不要手工合并两种文件。
