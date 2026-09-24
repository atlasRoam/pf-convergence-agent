# 扩展

CLI 支持 `--extension` / `-e <路径>` 显式加载扩展；独立包入口也可按配置与信任决策发现扩展。扩展以宿主进程权限执行，须审查来源与代码。`--no-extensions` 只关闭自动发现，显式路径仍有效。`install`、`remove`、`list`、`config` 和 `update [source]` 管理配置中的扩展来源；`update` 不更新 agentCore 程序、内置模型或 PFNT 引擎。

根包装器固定禁用自动扩展发现，显式加载 `source/packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts`。添加自己的 `-e` 时仍须自行审查安全性；直接运行包入口不会自动加载此保护。开发者 API 以 `src/core/extensions/types.ts` 的类型和源码测试为准。扩展示例保留在源码树供开发参考，不随 CLI 包的发布资产打包。
