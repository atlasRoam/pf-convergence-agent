# agentCore CLI 1.0.0

这是 PFSAA 源码候选的当前使用文档，不是 npm 发布说明。优先从仓库根的 `start.sh` / `start.ps1` 进入受控工作目录。直接执行 `@pfsaa/agentcore-cli` 的 `agentcore` 包入口时，项目资源发现、cwd 与权限取决于调用环境，根包装器的 PFNT Skill 和凭据防护不会自动注入。

## 入门与运行

- [快速开始](quickstart.md)、[Windows](windows.md)、[安全边界](security.md)
- [配置](settings.md)、[环境变量](environment-variables.md)、[会话](sessions.md)
- [Provider](providers.md)、[模型](models.md)
- [Skill](skills.md)、[扩展](extensions.md)
- [RPC](rpc.md)、[SDK](sdk.md)

CLI 支持交互、`--print` 文本、`--mode json` 事件流及 `--mode rpc` 标准输入/输出；完整参数以 `--help` 为准。`update` 是扩展来源操作，不更新程序。没有远程模型目录或在线分享入口。
