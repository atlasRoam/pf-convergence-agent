# PFSAA 当前架构说明

> PFSAA 派生版：Main 固定使用 `../source/packages/agentcore-cli/dist/index.js`，
> PfsaaHost 的工作目录为 `../runtime/`，会话沿用 `../runtime/.agent/sessions`。
> Host 只显式注入凭据 Guard 与两个产品 Skill，仅接受固定工作区；工作区快照
> 不扫描私有文件。下文介绍的是通用 PFSAA 架构；当前限制见 [PFSAA.md](../PFSAA.md)。

> 本文描述当前仓库已经实现的结构，不描述尚未落地的目标架构。
> 目标方案和后续计划请见 [产品与技术方案](product-plan.en.md)。

## 桌面兼容适配补充

`agentcore-command-arguments.ts` 解析真实模型 ID 与导出文件名。`sessions.export` 新增可选输出路径；Main 校验并解析项目相对路径和 `~/`，通过系统保存窗口确认路径及覆盖，取消返回 `null`，确认后才由 PfsaaHost 调用 AgentCore 导出器。`.jsonl` 路径选择 JSONL，其余为 HTML。

`settings-command-handler.ts` 通过 AgentCore getter 读取非 TUI 设置，仅将变更的重试、压缩/分支摘要（包括 `skipPrompt`）、网络、图片、授权、Shell、Session、资源和遥测字段通过 `FileSettingsStorage.withLock` 写回，保留嵌套 Provider 重试参数与未知设置。代理摘要隐藏既有凭据，未编辑时保留原值。Session Tree 浮层读取生效的 `skipPrompt`，配置为 AgentCore 无摘要路径时隐藏摘要控件。网络、Shell 和 Session 目录修改需重启 Host/应用；默认工具用于新建会话。

`extensions.syncEditor/invokeShortcut` 对应 `extension.editor.sync/extension.shortcut.invoke`，校验项目作用域与文本长度。前者只更新按项目/会话隔离的展示镜像，不创建 Agent；后者根据生效键位重新查询 AgentCore `ExtensionRunner.getShortcuts()`、同步当前草稿，并用真实 `createContext()` 执行处理器。`SessionCapabilities.extensionShortcuts` 只包含 key/description。`use-extension-editor.ts` 阻止输入法组合、重复按键、并行处理器和模态窗口中的快捷键派发。实时文本是异步桌面镜像，不冒充同步跨进程 TUI 组件。

PfsaaHost `extension-theme.ts` 保留真实 SDK Theme 对象及资源主题；`agentcore-adapter` 对版本对应的主题模块进行能力检测。稳定 Proxy 保证 SDK 复制 UI context 后 `ui.theme` 仍随选择更新。`extension.ui.presentation` 的 `action: "theme"` 携带 `ExtensionThemeSnapshot`，只传浅深色信息与十六进制颜色；Renderer 校验固定 token 白名单后作用于当前会话的工作区及浮层。交互式 `custom` factory 适配为有界的终端风格文本行和按键输入，组件实例不跨进程序列化。

Session Tree 使用固定宽度分支轨道，不随每条消息递增缩进。Host 迭代投影最多 5,000 个节点并明确提示截断；Renderer 每页最多 160 行。Skill 消息只展示技能名与用户请求，不展开嵌入的指令正文。普通/警告通知保留八秒，错误通知保留到手动关闭，所有通知均有关闭按钮。权限配置仅修复有效 JSON 末尾多出的字面量 `\n`；其他解析或写入失败不会覆盖文件或改变内存中的权限模式。缺失的 bash 默认规则会显式补齐，已有命令规则与显式默认规则保持不变。

手动压缩按钮依据 `isSending || isCompacting` 显示停止，先调用 `abortCompaction()` 再调用 `abort()`。取消/失败后暂存消息携带原 ID、顺序、文本和图片返回 AgentCore 原生队列，不自动执行。手动压缩和交互式扩展快捷键不使用普通 60 秒请求超时，但进程断开仍拒绝等待中的请求。

Host 重启后，若会话路径缓存尚未加载，操作会通过 AgentCore `SessionManager.list(cwd)` 解析真实持久化 ID；不存在的 ID 明确报错，不再静默创建空会话。运行时 smoke 在首次列表请求前验证该恢复路径。

验证新增范围：高级配置读写/非法值/凭据保留；扩展稍后注册模型的 `/model` 参数；带空格的 HTML/JSONL 路径与保存取消；手动压缩停止、队列保留且不自动续跑；快捷键的冲突/模态/输入法隔离；编辑器镜像、主题切换及会话隔离；可操作 TUI 兼容提示。界面验证使用隔离 AgentCore 目录和 Electron profile，不发送外部模型请求。

## 1. 产品边界

PFSAA 是 `@earendil-works/pi-coding-agent` 的桌面适配层：Renderer 负责交互和呈现，PfsaaHost 负责 AgentCore Session、ModelRuntime、Agent、Tool、Provider、资源和 CLI 兼容能力。

PFSAA 不提供：

- 第二套 Agent、模型目录、凭据存储或会话数据库。
- Renderer 侧的 Node.js、文件系统、Shell 或 AgentCore runtime 访问。

Provider API Key、OAuth 和其他凭据继续由 AgentCore Runtime 保存在本机 AgentCore 配置目录。PFSAA 可以在同一份 AgentCore `models.json` 中创建并管理包含多个模型定义的 OpenAI Chat Completions 兼容 Provider；配套的 `pfsaa-provider-ui.json` 只保存自定义服务商所有权和认证页可见性状态，绝不保存凭据，也不维护第二份模型目录。模型发现只在用户主动点击时由 PfsaaHost 请求用户填写的 `/models` 端点；结果仅作为候选项，勾选保存后才会写入配置。

`SessionCapabilities.changeReviewEnabled` 是 Host 提供的单轮 Git 审查能力开关。固定 PFSAA 运行时返回 `false`，因此 Renderer 不会请求审查数据，也不会渲染“审查不可用”的入口或抽屉。Provider 摘要只暴露脱敏后的生效认证来源以及是否存在本机凭据，不包含凭据或环境变量名。用户明确保存 API Key 时，类型化请求会将其传给 PfsaaHost 并立即经 AgentCore 持久化；PFSAA UI 状态文件不会保存密钥。

## 2. 当前运行时拓扑

```text
Sandboxed React Renderer
  └─ Preload: window.pfsaa
      └─ Electron Main
          ├─ BrowserWindow 生命周期
          ├─ IPC handler 编排
          └─ child_process.fork(PfsaaHost)
              └─ Electron 内置 Node（ELECTRON_RUN_AS_NODE）
                  └─ @earendil-works/pi-coding-agent
```

当前实现使用普通 Node `child_process.fork` 和 `process.send/process.on("message")`，不是 Electron `utilityProcess`，也不是 MessagePort。fork 目标是 Electron 自身可执行文件并带 `ELECTRON_RUN_AS_NODE=1`，即 Electron 内置 Node：内置 Node 满足 AgentCore runtime engines 时不存在 WebIDL/undici 兼容问题，且能透明读取 asar 归档，因此 node_modules 全部打包进 asar，仅原生 `.node` 模块与 `apps/desktop/assets` 经 `asarUnpack` 解包。若内置 Node 低于 AgentCore runtime 要求，则必须改用外部系统 Node 并整体解包 node_modules（系统 Node 不能读取 asar）。

无头 `pfsaa-cli` / `npm run cli -- <参数>` 使用独立直连路径：`packages/pfsaa-host/dist/cli.js` 加载选定 AgentCore runtime 并调用 AgentCore 官方 `main(args)`。`pfsaa-cli` 是 PFSAA 的兼容 CLI。Print、JSON、RPC、stdin JSONL 与 Auth Print 保留 AgentCore 自己的 stdout/stderr 和协议语义，不经过 Renderer/Main IPC 拓扑。

两个运行时定位入口：

- `PFSAA_NODE_EXECUTABLE`：显式指定 PfsaaHost 使用的 Node 可执行文件，缺省为 `process.execPath`（Electron 内置 Node）。
- `PFSAA_RUNTIME_MODULE`：显式指定 AgentCore runtime 入口文件。打包版本否则必须使用 `app.asar` 内由锁文件固定的 SDK；开发版本先解析仓库锁定依赖，再以全局 AgentCore 安装为兜底，避免无关的旧版全局 CLI 静默改变 API 面。

`packages/pfsaa-host` 同时向 `process.send` 和 `worker_threads` 的 `parentPort` 投递消息，因此进程宿主方式可替换，但当前 Main 只使用 `child_process.fork`。

### 2.1 Main

`apps/desktop/src/main/index.ts`

Main 只负责：

- 创建和销毁 BrowserWindow（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`）。
- 启动、监听和停止 PfsaaHost。生命周期回调绑定到触发它的进程实例，已替换 Host 的迟到 `exit` 不会拆掉新 Host；重启仅在真实 `runtime.status` IPC 往返成功后完成。
- 当显式代理环境变量与 AgentCore `httpProxy` 都未设置时，通过 Main/PfsaaHost 内部桥按每个请求 URL 调用 Electron 解析操作系统代理。
- 在 Renderer IPC 与 PfsaaHost 请求之间做编排。
- 为请求设置超时（默认 60s；`providers.login`、`sessions.share` 15min，`packages.*` 10min；`agent.prompt` 与 `input.externalEdit` 因完成由外部/事件驱动而不设固定超时），处理 Host 断开。
- 通过系统浏览器打开经过协议校验的 HTTP(S) URL，并拒绝窗口内新开链接。
- 在 Electron `userData/projects.json` 中记录项目目录引用、隐藏引用及其显示顺序。
- 构建应用菜单并按 `app:set-language` 切换菜单语言，文案取自 `@pfsaa/i18n`。
- 打开目录选择、会话导入和外部编辑器应用选择等原生对话框。Main 会校验所选可执行文件（或 macOS `.app`），只向 Renderer 返回兼容 AgentCore 的命令字符串，不开放通用文件系统访问。
- Windows 使用 Electron Window Controls Overlay 保留主题化顶栏。“工作台”右侧提供编辑/查看/帮助入口，复用原生应用菜单；1100px 及以下收为“菜单”按钮。560px 及以下将操作按钮移至第二行，避开原生 48px 窗口控制区；设置抽屉位于完整工具栏下方，常规为 48px，极窄 Windows 布局为 96px。macOS 继续使用系统菜单栏。`app:set-window-theme` 同步原生背景和控制按钮颜色。
- `app:popup-menu` 是经发送方校验的 Main 专用 IPC，由 `PfsaaBridge.app.popupMenu({ menu, x, y })` 暴露。严格契约仅允许 all/edit/view/help 和有界有限 CSS 像素坐标；Main 按稳定 ID 复用现有原生菜单，按缩放比例换算并限制坐标，关闭后返回。Renderer 不传可执行动作或菜单模板。鼠标打开保留编辑选区；键盘打开前恢复原内容焦点，关闭后返回触发按钮；失败显示本地化重试/重启提示。
- macOS 上设置 Dock 图标，并尝试加载 `pfsaa-miniwindow.node` 定制最小化窗口图标；加载失败只降级告警。

项目目录清单只保存 `cwd`，不保存 Session 或工作区内容。Renderer 单击项目时通过 `sessions.list(cwd)` 按需展开会话列表，并以独立展开状态保留其它项目，不改变当前中央会话；只有单击具体会话才切换工作区。项目右键“移除”只把 `cwd` 加入隐藏引用，不删除项目文件或 AgentCore Session。Main 不创建 `AgentSession`，不保存 Provider 凭据，也不执行用户 Shell 命令。

### 2.2 Preload

`apps/desktop/src/preload/index.ts`

Preload 通过 `contextBridge` 暴露 capability-scoped 的 `window.pfsaa`。Renderer 只能使用 contracts 中声明的能力，不能获得原始 `ipcRenderer`、Node 对象或 Credential 对象。

### 2.3 PfsaaHost

`packages/pfsaa-host/src/index.ts`

PfsaaHost 负责：

- 编排 `@pfsaa/agentcore-adapter`、SessionManager、AgentSession 和 ModelRuntime。
- 通过 AgentCore `ProjectTrustStore` 与 `hasTrustRequiringProjectResources()` 计算项目 AgentCore 资源授权，并用项目保存、父目录继承或全局默认的最终决定创建项目 `SettingsManager` 与 `ResourceLoader`。
- 读取/恢复 AgentCore Session，并通过 `SessionManager.appendCustomEntry()` 写入 `pfsaa.execution-run` 运行元数据。
- 转发 Agent event、Approval event、Auth event 和 Extension UI 请求。
- 持有 AgentCore `AgentSessionRuntime`，让 Extension command 获得 TUI-capable mode、官方 command-context actions、Session 替换/重绑定、诊断、异步错误、shutdown 请求，以及可取消/有超时的 Extension UI 请求；组件仍由 PfsaaHost 渲染，不进入 Renderer。
- 执行 AgentCore built-in tools、Bash、Provider 登录、AgentCore package 管理、权限模式读写和会话操作。
- 以原子方式编辑既有 AgentCore `models.json` 来创建 PFSAA 所有的 OpenAI Chat Completions 兼容服务商，在不进行网络探测的前提下刷新真实 `ModelRuntime`，并经 AgentCore 既有登录/凭据路径保存提交的 Key。只有 PFSAA 所有的定义可以真正删除；其他运行时条目只从认证页隐藏且可恢复。
- 读取 AgentCore 生效的 keybindings 并调用 AgentCore 配置的外部编辑器 helper；AgentCore 设置页读取当前生效命令与来源，并通过 AgentCore 自带的锁定 `FileSettingsStorage` 写入用户命令。AgentCore 会先按空格拆分编辑器命令，因此在 macOS/Linux 上，PfsaaHost 会把所选且带引号的绝对路径临时替换为不含空格的符号链接别名，调用同一个 AgentCore helper 后立即删除别名。Renderer 不直接启动编辑器，也不读取 AgentCore 配置文件。
- 在报告 `runtime.status=connected` 前初始化 AgentCore 自带的代理感知 HTTP dispatcher，使 OAuth Token 交换、模型请求和 Provider HTTP 调用使用同一条 PfsaaHost 网络路径。npm、pnpm、git 等 package manager 子进程仍使用各自的代理配置。
- 将跨进程数据转换成可 JSON 序列化的响应（`jsonSafe`），并对队列中的图片附件做旁路保存，避免 `promoteQueue` 丢附件。
- 以规范化 `cwd` + AgentCore 会话 ID 为每个内存 SessionManager、AgentSession、队列、审批和生命周期资源划分作用域。即使导入 JSONL 在不同项目保留同一 ID，删除、中止和队列操作仍保持项目隔离。
- 以异步外部进程和有界超时执行 Git 工作区检查及 `gh` 分享，避免阻塞 PfsaaHost IPC 循环。

AgentCore runtime 的动态定位、加载、模型/Session 适配，以及对 AgentCore 同版本 keybinding、settings-storage、external-editor 模块的兼容守卫集中在 `packages/agentcore-adapter`。AgentCore 权限配置、Extension UI 绑定、审批等待和策略切换集中在 `packages/permission-engine`。两者都不创建第二套 Agent、Provider 或 Session 存储；权威来源仍是 AgentCore runtime 和 `@gotgenes/pi-permission-system`。独立的 `packages/pfsaa-host/src/cli.ts` 只透明调用 AgentCore 官方 `main()`，不进入桌面 IPC 协议。

代理优先级依次为显式 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`、AgentCore 全局 `httpProxy` 设置、Electron 的跨平台系统代理解析结果。`agentcore-adapter` 先调用与当前 AgentCore 版本匹配的 `configureHttpDispatcher()`；仅在没有显式/AgentCore 代理时，才安装一层轻量 dispatcher，为每个请求 URL 请求 Main 执行 `session.resolveProxy(url)`。因此 PAC、绕过列表和按域规则仍保持 URL 感知，不会被压缩为启动时快照。解析失败会拒绝请求，不会静默回退直连；dispatcher 缺失或 API 不兼容时，PfsaaHost 会先发送脱敏的 `runtime.error` 再退出。

## 3. 当前仓库结构

```text
PFSAA/
├─ apps/desktop/
│  ├─ index.html                          # Vite Renderer 宿主页面
│  ├─ vite.config.mts                     # Renderer ESM 构建配置，输出到根目录 dist-renderer/
│  ├─ entitlements.mac.plist              # macOS 正式签名构建的 Hardened Runtime 权限
│  ├─ assets/                             # 应用图标、mac Info.plist、原生插件产物
│  ├─ native/miniwindow.mm                # macOS 最小化窗口图标原生定制源码
│  ├─ public/                             # Renderer 静态资源
│  ├─ scripts/
│  │  ├─ build-native.mjs                 # 原生插件构建（非 macOS 跳过）
│  │  ├─ behavior-regressions.test.cjs    # 安全、并发和打包行为级回归
│  │  └─ renderer-regressions.test.cjs    # Renderer 行为与结构守卫
│  └─ src/
│     ├─ main/index.ts                    # Electron Main、应用菜单与 IPC 编排
│     ├─ main/application-menu.ts         # 原生菜单模板、弹出校验与生命周期
│     ├─ preload/index.ts                 # contextBridge
│     └─ renderer/
│        ├─ App.tsx                       # 仅入口与 Controller/View 组合
│        ├─ main.tsx                      # Renderer 挂载入口
│        ├─ app-view.tsx                  # 工作区壳层与全局布局
│        ├─ app-sidebar.tsx               # 项目树、Session 列表与侧栏交互
│        ├─ app-conversation.tsx          # 会话 pane 缓存、对话区与 Composer 组合
│        ├─ app-overlays.tsx              # 快捷设置、对话框等全局浮层组合
│        ├─ use-app-controller.tsx        # 页面状态与动作编排
│        ├─ use-session-data.ts           # Session/能力/消息加载
│        ├─ use-runtime-events.ts         # PfsaaHost 运行时事件状态归一化
│        ├─ use-change-review.ts          # 有界、可持久恢复的 Session 审查视图/详情状态
│        ├─ change-review-model.ts        # 纯 diff/目录树/筛选/键盘投影
│        ├─ ui/change-review-merge.tsx    # 延迟加载的 CodeMirror 可编辑合并对话框
│        ├─ use-conversation-scroll.ts    # Session 滚动快照与最新位置
│        ├─ use-stream-deltas.ts          # 流式增量的有界批处理
│        ├─ use-global-shortcuts.ts       # 全局快捷键与焦点边界
│        ├─ use-preferences.ts            # 语言与主题偏好
│        ├─ use-notice.ts                 # 轻量提示状态
│        ├─ use-sent-images-cache.ts      # 待发送图片缓存
│        ├─ timeline-utils.ts             # 回合分组、执行摘要和稳定时间线项
│        ├─ message-utils.ts              # 消息 identity、快照合并和时间格式化
│        ├─ image-cache.ts                # 通过 idb 封装的 IndexedDB 图片预览缓存
│        ├─ agentcore-capabilities.ts            # AgentCore 资源不可用时的 slash 命令 fallback
│        ├─ palette-command.ts            # 直接执行命令与可编辑模板分流
│        ├─ types.ts                      # Renderer 状态与消息辅助类型
│        ├─ styles.css                    # 当前 UI token 与布局样式
│        ├─ vite-env.d.ts
│        └─ ui/                           # 展示层组件，按 UI 职责拆分文件
│           ├─ index.ts                   # UI 统一出口
│           ├─ message-timeline.tsx       # 会话时间线（文档流 + 早期消息折叠）
│           ├─ message-view.tsx           # 单条消息渲染
│           ├─ execution-summary.tsx      # “已处理”执行摘要
│           ├─ live-activity.tsx          # 实时思考与工具调用流
│           ├─ change-review.tsx          # 单轮文件变更审查面板/抽屉
│           ├─ pane-resize-handle.tsx     # 指针/键盘无障碍分栏手柄
│           ├─ composer.tsx               # 输入区、建议与队列投递
│           ├─ quick-settings.tsx         # 分层设置、任务操作与可搜索 AgentCore 命令
│           ├─ application-menu.tsx       # Windows 顶栏原生菜单入口
│           ├─ dialogs.tsx                # 重命名/信任/恢复/扩展 UI 等对话框
│           ├─ approval-card.tsx          # 工具审批卡
│           ├─ provider-settings.tsx      # Provider 认证设置
│           ├─ package-settings.tsx       # AgentCore package 管理
│           ├─ permission-level.tsx       # 权限等级控件
│           ├─ context-ring.tsx           # 上下文占用指示
│           ├─ working-indicator.tsx      # 运行中指示
│           ├─ task-row.tsx               # 会话行与状态标记
│           ├─ skeletons.tsx              # 骨架屏
│           ├─ markdown.tsx               # Markdown、代码块、数学公式与 Mermaid 图表渲染
│           └─ shared.ts                  # 剪贴板与菜单键盘导航 helper
├─ packages/
│  ├─ contracts/                          # Bridge/IPC 类型与 Zod 运行时 payload 校验
│  ├─ domain/                             # Task、Project 类型及共享运行时 helper
│  ├─ agentcore-adapter/                         # AgentCore runtime 定位、加载及模型/Session 适配
│  ├─ pfsaa-host/                            # PfsaaHost 进程入口和 Host command 编排
│  ├─ permission-engine/                  # AgentCore 权限配置、Extension UI 和审批等待
│  ├─ ui-system/                          # 共享 Icon/剪贴板基元与 focus-trap 适配层
│  └─ i18n/                               # zh/en 文案和命令描述
├─ docs/                                  # 架构、产品方案、AgentCore 能力矩阵与发布指南
├─ rules/                                 # 开发与文档同步规则
├─ .github/workflows/
│  ├─ ci.yml                              # main/PR 验证
│  └─ release.yml                         # Tag 原生安装包与 GitHub Draft Release
├─ scripts/verify-package-contents.mjs    # 打包后 asar 运行入口/许可证/禁入项验证
├─ scripts/smoke-source-runtime.mjs       # 启动构建后的 PfsaaHost 并执行真实运行时 IPC
├─ scripts/smoke-session-isolation.mjs    # 验证跨项目同 ID 会话保持隔离
├─ scripts/smoke-packaged-runtime.mjs     # 启动打包后 PfsaaHost 并校验内置 AgentCore runtime
├─ scripts/generate-packaged-sbom.mjs     # 从最终 asar 生成平台对应的 CycloneDX SBOM
├─ scripts/generate-third-party-notices.mjs # 确定性的生产依赖许可证清单
├─ scripts/verify-release-version.mjs     # Release Tag 与包版本一致性守卫
├─ dist-renderer/                         # Renderer 构建产物（不入库）
├─ release/                               # electron-builder 打包产物（不入库）
├─ electron-builder.config.cjs            # 公共运行时白名单与平台打包规则
├─ AGENTS.md
└─ package.json                           # npm workspaces 与构建/打包脚本
```

`packages/*` 每个包当前都只有单一 `src/index.ts`（`ui-system` 为 `src/index.tsx`）作为入口，没有更深的目录分层。它们负责代码边界拆分，不引入第二套 Agent、权限、会话或凭据系统。

Renderer 的展示层组件全部收敛在 `renderer/ui/`，并统一由 `ui/index.ts` 再导出；流式增量的有界批处理由 `use-stream-deltas.ts` 负责。早期版本中的单文件 UI 组件与性能 helper 已被这两处结构取代，历史文档若仍引用旧文件名，应按本节结构订正。

## 4. 依赖方向与边界

```text
renderer → contracts + domain + i18n + ui-system
preload  → contracts
main     → contracts + i18n（菜单文案）；按路径 fork packages/pfsaa-host/dist/index.js，不 import 其模块
pfsaa-host  → contracts + domain + agentcore-adapter + permission-engine
contracts → zod（PfsaaHost IPC 边界的严格运行时校验）
agentcore-adapter → AgentCore runtime（仅动态定位、加载和公开 API 适配）
permission-engine → contracts + @gotgenes/pi-permission-system 配置
ui-system → React + focus-trap
```

`packages/contracts` 同时提供 TypeScript 声明和可执行校验。公开类型指向 `src/index.ts`，PfsaaHost 运行时加载编译后的 `dist/index.js`；完整的 `PfsaaHostCommand` schema map 使用严格 Zod object 实现，拒绝未知字段和可强制转换的 IPC 值，不再维护第二套手写 schema 语言。workspace typecheck、桌面开发（`predev`）和生产构建（`prebuild`）按 `contracts → domain → agentcore-adapter → permission-engine → pfsaa-host → i18n → ui-system` 顺序编译。Vite 将 `@pfsaa/ui-system` 和 `@pfsaa/i18n` 直接解析到源码并排除依赖预打包，使共享图标/组件/文案改动可直接热更新，不再使用旧 `dist` 或浏览器预打包缓存；开发与生产环境仍由 Vite 将源码转换为 JavaScript，PfsaaHost 则加载编译后的 workspace 包。

必须遵守：

- Renderer 不得 import AgentCore runtime、Node builtin 或凭据对象。
- Main 不得直接创建 AgentSession。
- PfsaaHost 是当前唯一允许依赖 AgentCore runtime 的代码边界。
- 跨进程消息只能传 JSON/structured-clone 可序列化数据。
- 新增 IPC 必须先更新 `packages/contracts`，再实现 Main、Preload 和 Renderer。
- AgentCore fallback 能力必须独立于 UI 组件，并标明权威来源仍为 AgentCore CLI/SDK。

Renderer 图片预览仍只是非权威缓存。`image-cache.ts` 使用轻量 `idb` Promise 封装，同时保留现有 `pfsaa-cache` 数据库、`snapshots` object store、structured-clone 数据和值写入失败后的 `localStorage` fallback。Modal 焦点行为在 `ui-system` 中基于 `focus-trap` 统一实现；PFSAA 保留自己的对话框结构和应用壳层 inert 边界，由库负责嵌套 trap 栈、动态 tabbable 发现、Escape 路由与关闭后的焦点恢复。

快捷设置中的 AgentCore 命令子页与 Composer 模型选择器使用 `cmdk`，由同一个经过测试的交互基元负责筛选、活动选项语义、方向键导航、滚动与 Enter 执行；PFSAA 仍只负责 AgentCore 命令路由和模型切换副作用。不执行选项动作的普通筛选使用 Chromium 原生 search input；会话消息搜索仍保持 Session 数据感知，因为浏览器页面搜索无法读取已折叠且未挂载的历史消息。

Renderer 的会话时间线由 `app-conversation.tsx` 与 `ui/message-timeline.tsx` 组合，采用**普通文档流列表 + 早期消息折叠**，不使用虚拟列表。原因是 Mermaid、KaTeX、语法高亮都是异步定高，虚拟列表的测量-定位循环与之根本冲突（跳动、重叠、回弹）；改为只挂载最近 `FOLD_WINDOW = 200` 条消息，更早的消息折叠在"显示更早消息"按钮后，每次展开 `FOLD_STEP = 200` 条。防跳动依赖浏览器原生 scroll anchoring：`.conversation-scroll` 必须保持 `overflow-anchor: auto`（虚拟列表时代的 `none` 会关闭该机制）。

单轮文件审查由 PfsaaHost 的 `session-change-review.ts` 与 `session-change-review-store.ts` 负责。`agent_start` 捕获 Git 工作树基线，非 Steering 的 Follow-up 复用一个边界检查拆分轮次，Steering 保持同组；edit/write/Bash/PowerShell 后的运行中预览会去抖，过期扫描通过 `AbortController` 取消。settlement 执行权威比较并覆盖本轮提交后的 HEAD 变化。候选路径、基线内容、文件、单/总 patch、Git 超时均有硬上限，重命名、可执行模式、二进制、超大与截断状态显式建模；同一执行时段的外部修改无法与 AgentCore 修改可靠区分，UI 因此明确标注为“执行期间工作树变化”。

完整 patch 不再每轮无界追加到 Session JSONL。PfsaaHost 只写一个小型版本化 `pfsaa.change-review-store` custom-entry 锚点，并原子替换 Session 文件旁的 sidecar；该文件最多 20 轮/12 MB，随 JSONL 导出/导入复制，删除 Session 时一并移除。最近的有效旧 `pfsaa.change-review` 记录会在后续写入时复制进 sidecar；原有 append-only JSONL entry 为兼容性保留，但不再新增完整 patch entry；所有旧 entry、导入内容和 sidecar 都先经过 schema、相对路径、数量与字节上限校验，损坏 sidecar 会隔离。`sessions.changeReviews` 只返回摘要与 Git 可用性，`sessions.changeReview` 延迟加载所选轮次详情。sidecar 写入串行化，Main 退出前通过内部 `runtime.shutdown` 短暂等待最终写入。

审查 UI 可作为宽分栏或焦点受控抽屉打开；抽屉会把标题栏、项目侧栏、分界线和被覆盖的对话设为 inert，并在关闭后把焦点恢复到审查入口。它支持带日期/耗时/结果的圆角轮次选择、筛选与目录聚合、完整方向键树导航、统一/Codex 风格拆分 diff、自动换行、仅空白过滤、轻量语法高亮、变更块导航与处理、增量行折叠、复制路径，以及非 Git/Git/存储/详情失败重试。完整 UTF-8 文本 patch 可逐块接受或撤销；撤销需确认，并以零模糊度反向应用所选块。`change-review-merge.tsx` 延迟加载 CodeMirror 统一合并视图，既可逐块处理也可直接编辑最终内容。PfsaaHost 重建未处理块的基线，将普通文件限制在项目内，串行化修改、原子写入，并在编辑器打开后文件发生变化时拒绝保存；处理结果持久化到有界 sidecar。打开状态、轮次、文件、目录展开、尺寸、diff 选项与滚动位置均有界并按 Session 跨重启恢复，patch 仍只由 Host 持有。staging 与提交编排仍不提供；二进制、超大或截断 patch 保持只读。

每个访问过的 Session 保留独立 pane，非活动 pane 用 `visibility: hidden` 而非 `display: none`，浏览器因此天然保留各自的 `scrollTop`，无需手动恢复逻辑；其 scroll/resize/mutation observer 会断开，直到 pane 再次激活。快照 `ConversationScrollSnapshot` 只剩 `{ top, follow }`。follow 状态的退出**只认真实输入事件**（`wheel` 且 `deltaY < 0`、touch 上滑），不再从 `scrollTop` 变小推断——因为内容会真实收缩（流式行被最终消息替换、working 指示器消失、执行摘要折叠），按位移推断会误判成"用户上滚"从而杀死自动跟随。程序化平滑滚动期间用 `pinningRef`（含 1000ms 兜底超时）latch 住 follow，避免"跳到最新"按钮在动画中途闪回。Modal 浮层会把应用壳层标记为 inert 并从辅助技术树隐藏，共享焦点基元只允许最上层嵌套对话框处理 Escape。

PFSAA 的 Renderer `activity/completedActivity` 仍是当前进程内的展示状态，不会直接写回会话。为稳定恢复“已处理”耗时，PfsaaHost 在 `agent_start`、非 Steering 的 Follow-up 边界和 `agent_settled` 记录每个 execution group 的 `startedAt/endedAt/durationMs`，并通过 AgentCore 官方 `SessionManager.appendCustomEntry()` 写入 `pfsaa.execution-run` 自定义 entry；该 entry 不进入 LLM context。Renderer 通过 `sessions.runMetadata` 读取精确耗时，AgentCore 原始 thinking/tool 仅用于重建步骤内容。没有该元数据的旧会话显示“已处理”但不再从消息时间戳推断耗时。

## 5. 当前 Bridge 能力

以 `packages/contracts/src/index.ts` 的 `PfsaaBridge` 为准，当前已声明：

- `app.setLanguage/setWindowTheme/quit`
- `runtime.status`
- `projects.list/chooseDirectory/remove/trustStatus/setTrust`
- `sessions.list/create/delete/remove/messages/runMetadata/changeReviews/changeReview/capabilities/compact/export/import/rename/generateTitle/stats/share/changelog`
- `models.list/refresh`
- `workspace.snapshot`
- `input.keybindings/externalEdit`
- `providers.list/listHidden/discoverModels/create/update/remove/restore/login/logout/setApiKey/resolveAuth/openAuthUrl`
- `agent.prompt/executeBash/abort/setThinkingLevel/setModel/cycleModel/setScopedModels/queue/setQueueModes/clearQueue/promoteQueue/editQueue/deleteQueue`
- `sessions.compact/reload`、`settings.get/update/chooseExternalEditor`、`extensions.resolveUi/syncEditor/invokeShortcut`
- `packages.list/install/remove/update/configure/configureResource/checkUpdates`
- `approvals.resolve`
- `permissions.status/setMode`

每个 invoke handler 都会验证调用者是当前 PFSAA 窗口的主 frame。项目作用域调用只接受已记录在 Electron 项目注册表中的目录；新目录只能通过原生目录选择器加入注册表。会话导入也始终由 Electron 原生文件选择器取得 JSONL 路径，Renderer 不能提交任意文件系统路径。
- `events.subscribe`

`providers.list` 会报告脱敏后的认证来源、本机凭据可用性和定义是否归 PFSAA 所有；仅自建 Provider 会返回可编辑的地址及模型 ID/名称。`providers.discoverModels` 由 PfsaaHost 对用户指定的 OpenAI 兼容 `/models` 端点执行有超时、有响应体上限且禁止跳转的显式 GET，不会修改配置。`providers.create` 可写入多个已选模型；`providers.update` 只修改 PFSAA 所有的定义，并保留仍被选中模型的既有能力字段。新增和更新都会通过真实 `ModelRuntime` 做本地验证，不刷新远程模型目录；新 Provider 的 Key 仍经 AgentCore 凭据路径保存。`providers.remove` 只会真正删除 PFSAA 所有的定义；对于外部/运行时条目，它会先移除本机凭据（如有），再从此认证页隐藏。`providers.listHidden` 和 `providers.restore` 提供明确的恢复路径。环境变量、模型文件和运行时提供的认证仍由各自外部来源管理。失败会保留在确认对话框内，并可直接重试。

命名对应关系需要注意三处：

- `sessions.remove` 是 `sessions.delete` 的别名，两者走同一个 `sessions:delete` IPC 通道。
- `providers.resolveAuth` / `providers.openAuthUrl` 对应 IPC 通道 `providers:auth-response` / `providers:open-auth-url`；只有前者转发到 PfsaaHost 命令 `providers.auth-response`，后者由 Main 直接用系统浏览器打开。
- `sessions.changelog` 对应 PfsaaHost 命令 `app.changelog`；`projects.list/chooseDirectory/remove` 由 Main 结合 `projects.json` 与 PfsaaHost `projects.list`、`sessions.list` 组合完成，没有一一对应的 Host 命令。`projects.trustStatus/setTrust` 对应 PfsaaHost 中 AgentCore 的 `ProjectTrustStore`；PfsaaHost 计算项目保存、父目录继承或全局默认的最终决定，并将其传给每一次项目 `SettingsManager` 和 `ResourceLoader` 创建。

如果文档与 `packages/contracts` 不一致，以 contracts 和实现为准，文档必须在同一个变更中更新。

## 6. 当前事件流

`PfsaaRuntimeEvent` 声明的类型为 `runtime.status`、`runtime.error`、`agent.event`、`auth.event`、`approval.requested`、`approval.resolved`、`extension.ui.request`、`extension.ui.notify`。

当前实际以顶层 `type` 下发的消息有六种：

```ts
{ type: "runtime.status", payload: "connected" | "starting" | "disconnected" }
{ type: "runtime.error", payload: { message: string } }
{ type: "agent.event", taskId, event }
{ type: "approval.requested", taskId, requestId, event: { toolName, args } }
{ type: "auth.event", requestId, event }
{ type: "extension.ui.request", taskId, requestId, event: ExtensionUiRequest }
```

`approval.resolved` 和 `extension.ui.notify` 由 `packages/permission-engine` 经 PfsaaHost 的 `emit()` 下发，因此实际落到 Renderer 时是被包在 `agent.event` 的 `event.type` 里，而不是顶层 `type`。`approval.resolved` 只在切换权限模式导致挂起审批被自动放行或拒绝时产生，此时审批卡的清理由 Renderer 在 `permissions.setMode` 成功后本地完成；`use-runtime-events.ts` 中按顶层 `type` 匹配 `approval.resolved` 的分支当前不会命中。若要让顶层事件生效，需要在 PfsaaHost 侧改为直接 `postMessage`，并在同一变更中更新本节。

`runtime.status` 由 Main 统一发布：PfsaaHost 上报 `connected`，进程启动阶段为 `starting`，进程退出时为 `disconnected` 并拒绝所有挂起请求。

认证提示通过 `providers.resolveAuth`（IPC `providers:auth-response`）回传文本、选择项或取消状态；取消会结束 AgentCore 的等待，不会遗留挂起的登录请求，PfsaaHost 也会传播 AgentCore 的逐提示中止信号，避免 SDK 已取消的兜底提示残留 waiter。对于带版本保护的 AgentCore 0.84.2–0.85.1 OpenAI Codex 浏览器流程，PfsaaHost 在确认浏览器登录方式前预检 SDK 的固定本地回调端点。预检失败时保留当前选择提示，由 Renderer 显示可操作错误，用户仍可选择 AgentCore 的设备码方式。SDK 并行给出的手动认证地址输入在本地回调等待期间仅作为次要兜底；`providers.login` 成功后 Main 会恢复并聚焦 PFSAA 窗口。

`agent.event` 当前覆盖 Agent start/end、agent settled、turn start/end、message start/update/end/snapshot、tool execution start/update/end、queue update，以及 AgentCore 的 `ui_prompt_start` / `ui_prompt_end`。Extension UI 请求会在边界处明确归一化为可序列化的 `{ type, reason, kind, title?, lines? }` payload；普通对话框通过 `extension.ui.resolve`，AgentCore 自定义组件通过 `extension.ui.input` 转发终端按键序列。常驻的组件 Widget、Footer/Header 与 editor component 在 PfsaaHost 内按固定宽度渲染、截断并合并高频刷新；`extension.input.dispatch` 保留 terminal input 的 consume/rewrite 链，`extension.autocomplete` 用超时与取消信号执行 Provider，并只返回应用补全后的文本、光标和有限候选。`agent_end` 的 `messages` 来自 AgentCore runtime，Renderer 在后续自动重试或队列续接前即可合并本轮消息；`agent_settled` 再读取最终 Session 快照。Renderer 只使用可序列化的归一化对象，不接触 AgentSession 实例。

## 7. AgentCore 能力映射

- AgentCore Session / `cwd` → 左侧项目树、项目内会话列表与中央对话。
- AgentCore ModelRuntime → Provider 设置、模型选择和思考等级。
- AgentCore slash command / Prompt / Skill catalog → Composer 建议和快捷设置中的可搜索 AgentCore 命令子页。
- AgentCore Agent event → 流式回复、工具过程、审批和运行状态。
- AgentCore Session export/compact → 快捷设置中的会话操作；Session Tree 的 `/fork`、`/clone`、`/tree` → 统一的焦点约束分支浏览器。PfsaaHost 将 `SessionManager.getTree()` 投影为有界的可序列化摘要，标记活动路径并校验选中节点。Fork 调用 `AgentSessionRuntime.fork()`，将 AgentCore 返回的用户原文放入新会话的 Composer；clone 在当前叶节点复制会话；tree 在原会话内导航，可选调用 AgentCore 可取消的分支摘要。会话替换事件先将 Renderer 绑定到新的 AgentCore 会话标识，再加载时间线。
- AgentCore Agent steering/follow-up queue → Composer 队列面板、投递方式、图片、提升、编辑、删除和批处理模式。自动压缩期间输入进入 AgentCore 原生队列；手动压缩结束时没有活跃 Agent run，因此 PfsaaHost 使用按 Session 隔离的暂存队列，压缩后启动第一条并将其余消息按序交回 AgentCore。两条路径共用稳定 ID 的队列操作，预检门闩继续阻止并发直接 prompt。
- AgentCore package 管理 → 快捷设置中的 AgentCore packages 设置面板。
- 顶栏齿轮 / `Ctrl/Cmd + ,` 打开精简的快捷设置首页；任务操作与 AgentCore 命令进入子页，`Ctrl/Cmd + K` 可直接打开 AgentCore 命令子页；原顶栏 Provider 和独立命令入口已移除。所有设置抽屉在 macOS 与 Windows 上均从 `--titlebar-height` 下方展开。
- AgentCore 命令子页点击/回车通过 `renderer/palette-command.ts` 分流：内置命令调用已有桌面处理器，运行时标记 `source: "extension"` 的命令调用 AgentCore prompt 桥，Prompt/Skill 保留为可编辑模板；固定操作会过滤等价 slash command，避免同页出现重复行。可选来源元数据仅为 `SessionCapabilities` 增加字段，不新增 IPC 端点。入口卸载后，后续弹层通过共享的工作区焦点上下文恢复到原入口。
- AgentCore 权限系统模式 → 输入框下方的权限等级控件。
- AgentCore workspace 文件列表 → Composer 的 `@file` 引用候选。`workspace.snapshot` 同时返回 git `changes`，但当前 UI 没有独立的 Files / Changes 面板，该字段暂未消费。

对于当前没有稳定 Bridge 或 UI 的能力，必须显示未实现，不能伪造成功状态。PFSAA 不额外维护一套独立的 AgentCore CLI 执行面板。

## 8. 打包与分发

本地打包保留按当前主机运行的 `package:mac`，并为匹配的原生 Runner 提供显式的 `package:mac:arm64`、`package:mac:x64` 和 `package:win:x64`。安装包文件名包含操作系统和架构；每次构建后都会验证 asar 运行入口、PFSAA 声明、Electron/Chromium 运行时许可证与禁入项。随后原生打包 Job 会从 `app.asar` 启动 PfsaaHost，调用 `runtime.status`，并通过 `app.info` 校验内置 AgentCore runtime 与锁定版本一致。

`.github/workflows/release.yml` 由匹配版本的 Tag 触发（也可手动重建已有 Tag），要求 Tag commit 已包含在 `main` 中并锁定该 SHA，会拒绝与 `package.json` 版本不一致的 Tag，重新执行依赖声明、lint/typecheck/test/build 检查，再分别构建 Windows x64、macOS arm64 和 macOS x64。每个原生 Job 根据最终 `app.asar` 生成对应平台的 CycloneDX SBOM；最终 Job 生成 `SHA256SUMS.txt` 和 GitHub provenance attestation，并创建或更新 GitHub Draft Release。

原生打包 Job 通过受保护的 `release-signing` Environment，只在对应的 `electron-builder` 步骤中注入证书材料。存在相应签名与 Apple API Secret 时启用 macOS Hardened Runtime、entitlements 和公证；Windows Authenticode 使用独立证书 Secret。没有可信证书时仍可生成测试安装包，但不适合直接作为可信公开发行包。

## 9. 运行时验证

Windows 菜单改动需通过 Preload 桥验证 `app:popup-menu`：三组菜单和折叠入口、鼠标/键盘关闭、已有选区的复制/粘贴、缩放后定位、本地化、正式构建限制，以及未知分组/非法坐标拒绝。检查 375/560/760/1024/1440px 布局与系统窗口按钮避让，macOS 不应出现重复顶栏菜单。桌面菜单不调用 PfsaaHost。

修改 PfsaaHost、contracts、Main、Preload 或 Provider/Session 相关能力后，至少执行：

```text
runtime.status
projects.list
models.list
providers.list
providers.listHidden
providers.discoverModels/create/update/remove/restore
sessions.create
sessions.runMetadata
sessions.changeReviews
sessions.changeReview（不存在的 ID 返回 null）
sessions.capabilities
agent.cycleModel
  # 检查注册的扩展命令携带 source: "extension"。
workspace.snapshot
```

同时运行：

```bash
npm run lint
npm run typecheck
npm run test:renderer
npm run build
```

`npm run test:renderer` 会先执行 `prebuild` 编译全部 workspace 包，再用 `node --test` 运行 `apps/desktop/scripts/*.test.cjs` 中的 Renderer 结构守卫与安全/并发行为回归测试。
