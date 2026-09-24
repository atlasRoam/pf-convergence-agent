# PFSAA 产品与技术方案

> PFSAA 派生版：当前仅完成尚待 Windows 端到端验收的桌面开发接入，
> 不代表已可打包发布。固定路径、首版能力及验收边界见 [PFSAA.md](../PFSAA.md)；
> 下文上游规划仅作背景参考。

> 文档状态：与当前代码基线对齐；未实现项单独标记为计划。
>
> 更新日期：2026-09-23
>
> 目标平台：Windows、macOS

## 1. 产品定位与边界

PFSAA 是 `@earendil-works/pi-coding-agent` 的桌面 UI 适配层。它不重新实现 Agent、模型、会话存储、凭据或工具系统，而是把 AgentCore runtime/CLI 的本地能力映射到桌面工作区。

明确不做：

- 第二套 Agent、模型目录、凭据存储或消息数据库。
- 未经 AgentCore runtime/CLI 支持的业务能力。

Provider API Key、OAuth、Token 刷新和 Session 文件仍由 AgentCore Runtime 管理，凭据不进入 Renderer。

## 2. 当前实现基线

AgentCore runtime 基线为 `@earendil-works/pi-coding-agent@0.85.1`。PFSAA 不显式传入 `createAgentSession.tools`，由 AgentCore 应用项目/全局 `defaultTools` 设置（包括配置后可用的 Windows `powershell` 工具），同时保留 Extension 与自定义工具；模型摘要会过滤 AgentCore 通过 `null` 明确标记为不支持的思考等级，活动 Session 仍以 `AgentSession.getAvailableThinkingLevels()` 的权威结果为准。PFSAA 调用 `setModel()` / `setThinkingLevel()` 时传入 `{ persist: true }`，因此模型和思考等级变更会写入 AgentCore 的用户级设置；`/thinking [level]` 映射到桌面思考等级选择器，`/settings` 编辑同一份 SettingsManager 默认值。AgentCore 的 `ui_prompt_start` / `ui_prompt_end` 会在 PfsaaHost 边界归一化为可序列化 Agent 事件；桌面更丰富的队列编辑仍使用直接 AgentSession 队列 API，SDK 的 RPC `clear_queue` 不属于当前直连 Host 传输。AgentCore 0.85.1 的 GPT-6 Astra 目录由 `ModelRuntime` 动态读取，其 fork 压缩边界、分支摘要、会话导入、代理、Qwen 目录及 OpenAI Codex SSE 修复会直接进入现有桌面映射。PFSAA 自建 Provider 可在 AgentCore 既有的 `runtime/.agent/models.json` 中配置多个 OpenAI Chat Completions 兼容模型，支持手动录入模型 ID，或在用户主动请求后读取配置服务地址的 `/models` 候选列表并由用户勾选保存；创建和编辑均通过 `ModelRuntime` 本地验证，API Key 只提交到 PfsaaHost 并由 AgentCore 凭据存储持久化。PFSAA 只在无凭据的 `runtime/.agent/pfsaa-provider-ui.json` 中记录自己创建的服务商所有权和认证页隐藏项，不维护第二套 Provider/模型目录。

项目 AgentCore 资源遵循 AgentCore 的授权模型，不把“已打开项目”等同于自动允许加载。当项目存在受保护的设置、Extension、Skill、Prompt、主题、包、系统提示或项目 `.agents/skills` 时，PFSAA 会显示项目保存、父目录继承或全局默认的最终决定，并将其传给 `SettingsManager.create(..., { projectTrusted })`。在全局策略为 `ask` 且新增项目尚无决定时打开询问界面；同一项目级入口保留在项目右键菜单中。

当前可运行结构：

```text
React Renderer
  → Preload contextBridge(window.pfsaa)
  → Electron Main IPC
  → child_process.fork(PfsaaHost)
  → Electron 内置 Node（ELECTRON_RUN_AS_NODE）
  → @earendil-works/pi-coding-agent
```

当前代码不是 Electron `utilityProcess`，也不是 MessagePort。`packages/pfsaa-host` 使用普通 Node `process.send/process.on("message")`。PfsaaHost 运行在 Electron 内置 Node 中（满足 AgentCore runtime 的 Node engines 且可读取 asar），node_modules 打包进 asar，仅原生 `.node` 模块与 `apps/desktop/assets` 解包。

### 2.1 当前目录

```text
apps/desktop/
├─ index.html                    # Vite Renderer 宿主页面
├─ vite.config.mts               # Renderer ESM 构建配置，输出 dist-renderer/
├─ assets/ · native/ · public/   # 图标、macOS 原生定制源码、静态资源
├─ scripts/                      # build-native.mjs、renderer-regressions.test.cjs
└─ src/
   ├─ main/index.ts              # Main、应用菜单与 IPC 编排
   ├─ preload/index.ts           # contextBridge
   └─ renderer/
      ├─ App.tsx                 # 入口与组合
      ├─ main.tsx                # Renderer 挂载入口
      ├─ app-view.tsx            # 工作区壳层与全局布局
      ├─ app-sidebar.tsx         # 项目/Session 侧栏
      ├─ app-conversation.tsx    # 会话 pane 与 Composer
      ├─ app-overlays.tsx        # 快捷设置与对话框浮层
      ├─ use-app-controller.tsx  # 状态与动作编排
      ├─ use-session-data.ts     # Session 数据加载
      ├─ use-runtime-events.ts   # PfsaaHost 事件归一化
      ├─ use-conversation-scroll.ts # 滚动快照与最新位置
      ├─ use-stream-deltas.ts    # 流式增量有界批处理
      ├─ use-global-shortcuts.ts # 全局快捷键与焦点边界
      ├─ use-preferences.ts      # 语言与主题偏好
      ├─ use-notice.ts           # 轻量提示状态
      ├─ use-sent-images-cache.ts # 待发送图片缓存
      ├─ timeline-utils.ts       # 回合分组与执行摘要
      ├─ message-utils.ts        # 消息合并与 identity
      ├─ types.ts                # Renderer 状态与辅助类型
      ├─ image-cache.ts · agentcore-capabilities.ts · styles.css · vite-env.d.ts
      └─ ui/                     # 时间线、消息、Composer、分层快捷设置、对话框、设置等展示组件

packages/
├─ contracts/                    # Bridge/IPC 类型，纯类型包无 dist
├─ domain/                       # 类型与共享领域 helper
├─ agentcore-adapter/                   # AgentCore runtime 定位、加载和公开 API 适配
├─ pfsaa-host/                      # PfsaaHost 进程入口
├─ permission-engine/            # 权限配置与审批适配
├─ i18n/                         # zh/en 文案
└─ ui-system/                    # Renderer 共享 UI 基元
```

完整边界见 [当前架构说明](architecture.en.md)。

## 3. 当前用户闭环

当前已支持：

1. 启动 PfsaaHost 并显示 Runtime 状态。
2. 自动发现 AgentCore Session 所属项目，记住用户手动添加的项目目录，并支持通过项目右键菜单隐藏目录引用（不删除文件或 Session）。
3. 按需同时展开多个项目的会话列表；项目展开状态彼此独立，仅在用户单击具体会话时切换中央工作区；无会话项目可在其展开区域直接创建首个 Session，并支持创建、切换、删除本地 Session。
4. 读取和显示 Session 消息。
5. 选择已认证 Provider/Model 和思考等级。
6. 发送 Prompt、查看流式回复和停止运行。
7. 查看工具调用、工具结果和审批卡。
8. 通过 `@file` 引用工作区文件。
9. 压缩上下文并导出 JSONL/HTML，导入 AgentCore JSONL 会话、重命名和查看会话统计。
10. 使用 AgentCore slash command catalog、Prompt、Skill 和 Extension command 建议。
    快捷设置保留精简首页，将任务操作与可搜索 AgentCore 命令放入子页；`Ctrl/Cmd + K` 直接打开命令子页，顶栏齿轮与 `Ctrl/Cmd + ,` 打开首页。命令通过点击/回车执行，模板继续明确标注并保留编辑流程；设置抽屉从共享顶栏下方展开，头部紧凑，连续切换弹层后可恢复焦点。
11. 使用 Provider API Key/OAuth 本地认证；Provider 设置可新增 OpenAI Chat Completions 兼容服务商，并删除由 PFSAA 创建的服务商。内置、Extension 或外部配置服务商可从认证页移除并在之后恢复显示，但不会伪装为已经删除其底层 AgentCore/外部定义。OpenAI Codex 浏览器登录默认使用 AgentCore 的本地回调，手动输入回调地址仅作为兜底，成功后自动聚焦 PFSAA。PfsaaHost 网络请求依次遵循显式代理环境变量、AgentCore 全局 `httpProxy` 和跨平台系统代理。
12. 切换中文/英文和浅色/深色主题。
    Windows 在“工作台”右侧显示原生编辑/查看/帮助菜单，窄窗口合并为“菜单”；macOS 保留系统菜单栏。复用现有原生动作，支持编辑选区保留、键盘访问与中英文文案。
13. 使用 Steering / Follow-up 队列（包括运行中 prompt 自动压缩期间提交消息时进入 AgentCore 原生队列）、批处理模式和队列消息面板。
14. 对长会话使用"普通文档流 + 早期消息折叠"（只挂载最近 200 条，更早消息折叠在"显示更早消息"按钮后），并按 Session 缓存消息 pane、滚动位置和 follow 状态。
15. 使用 `/copy`、`/share`、`/changelog`、`/hotkeys`、`/trust`、`/resume`、`/quit` 和 `/scoped-models` 的桌面映射；项目 AgentCore 资源授权同时放在项目右键菜单中，全局默认策略为 `ask` 时，没有项目保存或父目录继承决定的新项目会询问一次；`/share` 依赖本机 `gh` CLI。
16. 在 AgentCore Session 自定义 entry 中持久化每次 Agent 运行的精确起止时间，关闭并重启后保持“已处理”耗时一致。
17. 从 Composer 摘要打开有界的 Git 单轮变更审查：响应式无障碍面板、详情延迟加载、轮次/文件/目录恢复、筛选、统一/Codex 风格拆分 diff、变更块导航与逐块接受/撤销、可编辑合并，以及明确的可用性、错误与截断状态。
18. 配置带顺序和单模型 thinking 等级的模型范围；管理单个 AgentCore package 资源、检查/执行更新并刷新同一 AgentCore Runtime 的模型目录。
19. 使用提示历史、Tab/Enter 资源补全、AgentCore 配置的外部编辑器、图片粘贴/拖放、AgentCore `keybindings.json` 驱动的模型/thinking/搜索/编辑器快捷键，以及可展开折叠消息的当前会话搜索。AgentCore 设置页明确区分自动优先级与自定义用户命令，显示当前生效来源，并可通过系统应用选择器填充命令（Windows 可执行程序、macOS 应用或可执行文件）。选中的命令仍通过 AgentCore 自带的锁定设置存储持久化；清除覆盖后恢复自动优先级。对于 Unix 上包含空格的已选绝对路径，PfsaaHost 仅在一次编辑期间创建别名，以兼容 AgentCore 的外部编辑器 helper。
20. 通过 `npm run cli -- <参数>` / `pfsaa-cli` 使用无头兼容入口；`pfsaa-cli` 是 PFSAA 的兼容 CLI。Print、JSON、RPC、stdin JSONL 与 Auth Print 全部直接委托给 AgentCore 官方 `main()`。

## 4. 消息与对话行为

- AgentCore 原始 Session message 是事实来源。
- Renderer 不把 AgentCore runtime 实例传入组件，只接受可序列化消息对象。
- Markdown、代码块、表格和链接由 Renderer 展示层渲染，不改变 AgentCore 原始消息。
- 会话标题已经避免直接使用完整 Skill 文本；首条用户消息后，标题在重新加载安全的截断回退基础上，会异步升级为 LLM 对首条消息的 3–8 词摘要（新增 `sessions.generateTitle` 桥：PfsaaHost 用 `ModelRuntime.complete` 摘要首条消息，成功后再经 `sessions.rename` 持久化），手动改名优先于 LLM 升级。PFSAA 只保留紧凑的 Skill 引用，并与用户实际追加内容分开展示，不把注入正文作为普通用户消息重复显示。
- 工具调用和思考过程应作为可折叠 Activity 展示，并显示工具数量、思考块数量和耗时。
- AgentCore 原始 thinking/tool 内容用于重建“已处理”摘要里的步骤内容；精确耗时来自 PfsaaHost 在 `agent_start`、Follow-up 分组边界和 `agent_settled` 通过 `SessionManager.appendCustomEntry()` 写入的 `pfsaa.execution-run` 元数据，Steering 消息继续共享同一 execution group。运行时 `completedActivity` 仍不是持久化字段；没有元数据的旧会话只显示“已处理”，不根据消息时间戳推断耗时。
- 单轮审查在 `agent_start` 与 Follow-up 边界捕获 Git 工作树，Steering 继续归入同组；变更工具后的预览会去抖并取消过期扫描，settlement 时连同 HEAD 变化执行权威比较，再用 AgentCore 公开的 `generateUnifiedPatch()` 生成 patch。运行前脏文件只有字节、模式或路径在本轮改变时才计入；同一时段的外部修改也可能包含，UI 会明确提示。候选扫描、基线字节、文件、patch、历史、挂载行、视图缓存与 IPC 均有界。严格校验的记录保存在原子替换、最多 20 轮/12 MB 的 sidecar 中，由一个最小 AgentCore custom-entry 锚点关联；列表 IPC 只返回摘要，所选详情延迟加载。面板/焦点受控抽屉支持筛选、目录聚合与键盘树导航、统一/Codex 风格拆分及换行/空白选项、语法高亮、变更块导航与处理、CodeMirror 可编辑合并、行折叠、重命名/模式/二进制/截断/重试状态，并跨重启按 Session 恢复轮次、文件、目录、尺寸、选项和滚动。破坏性撤销需要二次确认；保存使用原子写入，若文件在编辑器打开后发生变化则拒绝覆盖。
- 思考摘要、流式回复和最终 Assistant 消息复用稳定时间线项，避免回复完成时卸载/重建整段消息列表。
- 切换 Session 时立即定位到该会话的最新位置或保存的位置，不播放跨会话滚动动画。
- 用户手动离开底部时显示“回到最新消息”，不强制抢夺滚动位置。
- 排队消息新增、插入和处理时，只有在用户仍处于 follow 状态才自动滚动；用户向上滚动后立即退出 follow。

## 5. 当前 Bridge 契约

当前唯一权威定义是 `packages/contracts/src/index.ts`。主要能力：

```text
app.setLanguage/setWindowTheme/quit
runtime.status
projects.list/chooseDirectory/remove/trustStatus/setTrust
sessions.list/create/delete/remove/messages/runMetadata/changeReviews/changeReview/capabilities/compact/export/import/rename/generateTitle/stats/share/changelog
models.list/refresh
workspace.snapshot
input.keybindings/externalEdit
settings.get/update/chooseExternalEditor
providers.list/listHidden/discoverModels/create/update/remove/restore/login/logout/setApiKey/resolveAuth/openAuthUrl
agent.prompt/abort/setThinkingLevel/setModel/cycleModel/setScopedModels
agent.queue/setQueueModes/clearQueue/promoteQueue/editQueue/deleteQueue
approvals.resolve
events.subscribe
extensions.resolveUi
packages.list/install/remove/update/configure/configureResource/checkUpdates
permissions.status/setMode
```

Renderer → Preload → Main → PfsaaHost 是唯一通信链路。新增 IPC 必须先更新 contracts，再实现 Main、Preload 和 Renderer。

## 6. Slash 命令策略

AgentCore CLI 内置 slash command 的权威清单来自 AgentCore ResourceLoader/SDK，fallback 只在运行时资源不可用时使用。

当前已映射或应映射到原生 UI 的命令：

- `/login`、`/logout` → Provider 设置。
- `/model` → 模型选择器。
- `/compact` → `AgentSession.compact()`。
- `/export` → AgentCore Session HTML/JSONL 导出。
- `/new` → 新建 Session。
- `/reload` → 重载 AgentCore 资源/重新读取初始数据。
- `/import`、`/name`、`/session`、`/share` → 通过 Electron 原生 JSONL 选择器完成 PfsaaHost 会话导入、命名、统计和 GitHub Gist 分享。
- `/copy`、`/changelog`、`/hotkeys`、`/resume`、`/quit` → Renderer/Electron 桌面操作。
- `/trust` → 由 AgentCore `ProjectTrustStore` 支持的项目级 AgentCore 资源状态与授权界面；项目右键菜单和全局默认策略为 `ask` 时的新项目引导使用同一界面。
- `/scoped-models` → AgentCore 模型范围设置。
- `/fork`、`/clone`、`/tree` → 统一响应式 Session Tree 浏览器，支持搜索、对话/全部事件过滤、键盘导航、当前位置/活动路径/分叉点标记、节点预览、可选且可取消的离开分支摘要，以及权威会话替换与时间线恢复。

没有稳定 Bridge 的命令不得让模型把它当普通 Prompt 执行，也不得伪装成已经完成。UI 应显示可操作的“当前桌面端尚未支持”提示。

`/skill:name` 必须交给 `AgentSession.prompt()`，由 AgentCore runtime 负责 Skill 展开；PFSAA 只显示紧凑的 Skill 引用，并将可选的用户追加内容与注入正文分开。

## 7. 权限与审批

### 7.1 当前实现

当前 PfsaaHost 使用 `AgentSession.agent.beforeToolCall` 做适配：

- `read`、`grep`、`find`、`ls` 默认允许。
- 其他工具进入 PFSAA 审批卡。
- 用户拒绝后返回阻止结果。

### 7.2 `@gotgenes/pi-permission-system` 现状

PFSAA 已将 `@gotgenes/pi-permission-system@31.1.1` 作为桌面 PfsaaHost 的 Extension 依赖，并通过 AgentCore `DefaultResourceLoader.additionalExtensionPaths` 加载。它保留 PFSAA 使用的扁平 `permission` / `yoloMode` 配置，同时增加读写方向路径策略、无法解析 Bash 及重定向的安全关闭处理、按 Session 定位的权限服务和动态工具面过滤。PFSAA 不使用该扩展已删除的 root service accessor，也不对 decision attribution 枚举做穷尽分支。桌面端提供以下模式：

- `allow`：静默允许工具执行。
- `ask`：执行前由 AgentCore 权限系统请求审批。
- `deny`：阻止工具执行。
- `yolo`：开启插件 `yoloMode`，自动批准 `ask`，用于全自动执行。

设置变更写入插件的全局 AgentCore 配置，并显示在输入框下方的当前权限等级控件中。切换不会中断正在运行的 Agent；空闲 Session 会在下一次提示前按新策略惰性重建。Extension 不可加载时，PfsaaHost 才回退到内置 `beforeToolCall` 审批适配。

接入约束：

1. 在 PfsaaHost 中通过 AgentCore Extension 机制加载真实包。
2. 让插件配置继续使用其 AgentCore 配置目录和 schema。
3. 将 `allow/ask/deny` 和 `yoloMode` 映射为只读状态/设置 UI。
4. 将插件的审批事件和决定事件归一化到 contracts。
5. 移除重复的 PFSAA 自定义审批门，避免一次工具调用出现两套审批。
6. 通过真实工具调用验证 allow、ask、deny、session approval 和失败关闭行为。

## 8. 当前边界与后续计划

以下仍是计划，不是当前产品承诺：

- 变更审查中的 staging 与提交编排仍不属于当前产品承诺。

Extension 的组件 Widget、terminal input、同步 editor component、autocomplete provider、Footer、Header 与 TUI `custom` 均已通过有界的画面/按键桥接适配，AgentCore 原生 `/llama` 可在桌面端运行。组件实例保留在 PfsaaHost，不跨进程传递；实时编辑文本、扩展快捷键执行和 AgentCore 主题颜色映射已接入。

当前兼容基线还包括：手动压缩取消后不自动执行暂存提示、`/model provider/model`、带系统保存确认的 `/export 路径`，以及通过 AgentCore 锁定存储持久化的重试、压缩、代理、超时、默认工具高级配置。具体行为和重启要求见[功能矩阵](agentcore-feature-matrix.zh-CN.md#命令设置与-extension-兼容)。

## 9. 技术与安全约束

- Node.js `>=22.19.0`，并满足当前 AgentCore runtime engines。
- Renderer 禁止 Node builtins、AgentCore runtime、Credential 和任意 IPC。
- Main 只做窗口、IPC 编排和 PfsaaHost 生命周期。
- PfsaaHost 承担 AgentCore runtime、Agent、Tool、Provider、Session 和资源。
- 跨进程只传 JSON/structured-clone 可序列化 DTO。
- 外部 URL 只允许 HTTP(S)，通过系统浏览器打开。
- Renderer 强制执行严格的内容安全策略，并拒绝窗口内导航。
- 打包版本默认加载安装包内锁定的 AgentCore runtime，只有 `PFSAA_RUNTIME_MODULE` 可显式覆盖。
- API Key、OAuth Token 不进入 Renderer、日志、事件或 DevTools。
- PfsaaHost 在进入 connected 状态前安装与当前 AgentCore 版本匹配的代理感知 HTTP dispatcher；显式环境配置优先于 AgentCore `httpProxy`，后者又优先于 Electron 解析的系统代理回退。
- 失败状态必须可见并提供重试或修复操作。

## 10. 验收命令

每次修改依赖、contracts、PfsaaHost、Provider、Session 或 Renderer 核心交互后运行：

```bash
npm install
npm run notices:check
npm ls --all
npm ls --depth=0 --workspaces
npm run typecheck
npm run test:renderer
npm run build
npm run smoke:runtime
npm run smoke:cli
# 需要已配置凭据；执行真实 GPT-5.5 通信矩阵。
npm run acceptance:network
```

通信方式的逐格条件与清理保证见[网络验收矩阵](network-acceptance-matrix.zh-CN.md)。

Release Tag 还会验证 Tag commit 属于 `main` 并锁定其 SHA，在 Linux 上执行同一套验证，再分别在匹配的原生 GitHub Runner 上构建 Windows x64、macOS arm64 和 macOS x64 安装包。工作流从每个平台最终包生成独立 SBOM，并创建包含 SHA-256 校验和的 Draft Release；可信公开分发还需要在受保护的 `release-signing` Environment 中配置平台签名和 macOS 公证 Secret。

PfsaaHost 相关修改还要验证：

```text
runtime.status
projects.list
models.list
providers.list
providers.listHidden
providers.discoverModels
providers.create/update/remove/restore
sessions.create
sessions.runMetadata
sessions.capabilities
agent.cycleModel
workspace.snapshot
```

## 11. 开发说明

项目开发边界、代码规范、依赖管理和验收要求见 [AGENTS.md](../AGENTS.md)。
