# agent-core 当前实现参考

`@pfsaa/agent-core` 1.0.0 的入口与导出以 [package.json](../package.json) 和 [src/index.ts](../src/index.ts) 为准：agent 循环、工具调用、harness 上下文/运行时和会话存储分别由对应源码与测试定义。CLI 会话 JSONL 与 harness 会话存储不是同一个格式版本，不能混用。

- [遥测 schema](telemetry-schema.md)：由 `scripts/generate-telemetry-docs.ts` 从代码生成，改动时修改 schema 或生成器，不手工编辑生成内容。
- [harness 实现](../src/harness/) 与 [harness 测试](../test/harness/)：当前行为的主要参考。

旧的 pico、mobile-handoff、work-packages 和路线图是上游提案，不是当前产品契约；正式 PFSAA 阶段材料保留在仓库外层 `docs/`。
