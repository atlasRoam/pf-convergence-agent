# AgentCore 开发规则

- 本目录是通用 AgentCore 源码，不是运行工作目录；产品入口和公开仓库边界见根目录 `README.md`。
- 不要把本地运行数据、凭据、会话、私有 Skill、引擎或算例加入源码及版本库；本机 `../runtime/` 不属于公开快照。
- AgentCore 基于 Pi 的代码继续保留原有 MIT 版权和许可；新增的 PFSAA 内容遵循仓库根目录 Apache-2.0 许可。
- 优先做有界静态检查并运行 `git diff --check`。Windows 完整构建与测试通过之前，不要声称核心或桌面端已完成验收。
- 代码变更遵循 KISS、YAGNI，并保留现有注释语言；未经明确请求，不使用真实 Provider、私有数据或创建发布提交。
