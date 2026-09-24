# 电力系统潮流计算调整智能体(PFSAA)

PFSAA 是面向电力系统潮流计算调整任务的桌面产品层。它通过
Renderer → Preload → Electron Main → PfsaaHost → AgentCore runtime 的既有链路，
提供会话、流式消息、工具结果、审批和扩展交互；它不创建第二套 Agent、模型、
凭据或会话实现。

[English](README.en.md)

## 产品与核心边界

- **PFSAA**：产品名、桌面应用、`PfsaaHost`、首方包 `@pfsaa/*`、新的桌面偏好和运行时配置。
- **AgentCore**：`source/` 中的 Agent、CLI、会话、模型、工具与资源加载，是唯一的核心实现。
- **上游兼容**：`@earendil-works/pi-coding-agent`、旧 `PIDECK_*`/`PFCA_*` 环境变量和旧桌面偏好键仅用于读取既有依赖或状态；新写入一律使用 PFSAA 名称。

固定工作区使用项目中的 `source/` 与 `runtime/`。会话仍由 AgentCore 保存在
`runtime/.agent/sessions/`；桌面端只迁移自己的偏好、图片缓存和审查附属元数据，
不会复制、合并或改写既有会话库。

Provider 认证页新增的服务商仍使用 AgentCore 的 `runtime/.agent/models.json` 与
凭据存储：桌面端只负责受控地写入 OpenAI Chat Completions 兼容定义，并在不含密钥的
`runtime/.agent/pfsaa-provider-ui.json` 中记录自己创建的服务商和认证页隐藏状态。
因此 PFSAA 创建的服务商可以真正删除；内置、扩展或外部配置服务商只能从该认证页
隐藏并可恢复，绝不改写其外部来源。

PFSAA 自建服务商支持后续编辑和多个模型。可手动填写模型 ID，也可在明确点击
“获取模型列表”后由 PfsaaHost 请求服务地址的 OpenAI 兼容 `/models` 端点；发现结果
只供用户勾选，不会自动写入配置。连接失败时仍可手动配置。

## 当前范围

首版支持一个固定 PFSAA 工作区的会话与任务交互。Renderer 不直接访问 Node、
私有 runtime、SDK 或凭据；所有跨进程数据均经类型化 Preload 接口和 Host 校验。
不支持的上游能力必须由 Host 拒绝并在界面中显示可操作的错误，不能仅靠隐藏按钮。

专业计算仍只能由已加载的 AgentCore Skill 和现有 PFNT 工具处理。桌面端不会直接
修改 DAT 原件、推断引擎或把数值收敛伪装成工程结论。

公开仓库不包含项目专用 Skill、PFNT 引擎或算例。桌面端在没有这些私有资源时仍可启动，
但专业潮流调整能力需要用户在本地提供相应 Skill、引擎和工具。

## 开发与验证

Linux 用于源码开发；Windows 是构建和交付验收环境。每次产品改动都要将
`source/`、`desktop/`、相关文档和锁文件作为同一版本同步到 Windows，
同时排除 `runtime/`、`node_modules/`、构建产物和打包产物。同步前备份 Windows
已有副本，传输后核对哈希。

在 Windows 上依次完成：

1. 使用 npm 官方命令重建与核对 `source/package-lock.json` 和 `desktop/package-lock.json`。
2. 构建 AgentCore，再运行桌面端 `typecheck`、渲染器测试、Host 冒烟和生产构建。
3. 用隔离 runtime 验证窗口、IPC、持久会话恢复和 Skill 加载；真实 Provider 或真实算例仅在获得明确授权后运行。

当前实现和限制见 [PFSAA 集成合同](PFSAA.md)、
[架构说明](docs/architecture.zh-CN.md) 与
[AgentCore 功能矩阵](docs/agentcore-feature-matrix.zh-CN.md)。

## 从源码启动

需要 Node.js `>=22.19.0`。在 Windows 项目副本的 `desktop/` 中安装锁定依赖后：

```powershell
npm run dev
```

桌面开发启动依赖同一项目中的已构建 AgentCore runtime；运行时会按需创建本地
`runtime/` 目录。公开仓库不包含项目根启动包装器或项目专用 Skill。需要使用 CLI 时，
请按 [AgentCore CLI 文档](../source/packages/agentcore-cli/docs/index.md) 配置自己的资源；
桌面端直接连接 Host，不会通过 CLI 再建立并行会话通道。

## 发布边界

当前版本是与相邻项目 runtime 配合的受控集成，尚未声明为可脱离项目目录独立运行的
安装包。打包、签名、运行时捆绑和升级策略须在 Windows 验收通过后单独决策。
