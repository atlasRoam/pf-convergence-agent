# SDK

包入口 `@pfsaa/agentcore-cli` 提供 `createAgentSession` 等本地 SDK API；实现见 `src/core/sdk.ts` 和 `src/index.ts`。调用者可提供 `cwd`、`agentDir`、模型运行时、会话管理器、设置管理器和资源加载器。示例仅表示模块使用方式，不代表包已在 npm 发布。

SDK 不执行仓库根 `start.sh` / `start.ps1`，不会自动设置 `runtime/` cwd、`AGENTCORE_AGENT_DIR`，也不会自动加载 PFNT Skill 或凭据防护扩展。集成方需显式建立这些边界并自行配置 Provider。若需要标准输入/输出的进程集成，参见 [RPC](rpc.md)。
