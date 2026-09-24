# AgentCore CLI → PFSAA 当前功能矩阵

> PFSAA 派生版：首版保留 SDK 会话、流式事件和审批，仅支持固定 `runtime/`
> 工作区。PfsaaHost 禁止通用多项目发现、工作区扫描、变更审查、会话导入／分享和
> 包管理。下表是 PFSAA 上游能力，不能视为 PFSAA SDK 已验收。见 [PFSAA.md](../PFSAA.md)。
> 固定运行时中 `SessionCapabilities.changeReviewEnabled` 为 `false`；Renderer 不会调用审查 IPC，也不会显示不可用的审查控件。

> 本文只记录当前仓库已经接入的能力。未实现能力会明确标记，不把产品计划写成现状。
> 权威来源是当前安装的 `@earendil-works/pi-coding-agent`、`packages/contracts` 和 PfsaaHost 实现。

## 已接入

### 命令、设置与 Extension 兼容

- 手动压缩期间显示停止按钮，先调用 `abortCompaction()` 再调用 `abort()`。取消或失败后，暂存消息返回 AgentCore 队列，不会自动启动下一轮；长时间压缩不再受普通 IPC 的 60 秒超时限制。
- `/model provider/model` 使用真实运行时目录（包括扩展稍后注册的 Provider）；不带 Provider 的 ID 必须唯一。`/export 路径` 保留空格，`.jsonl` 输出 JSONL，其余输出 HTML；显式路径进入带覆盖确认的系统保存窗口。原有 `/export jsonl`、`/export html` 仍可用。
- AgentCore 设置 → 高级配置提供 Agent/Provider 重试、压缩与分支摘要 Token、AgentCore 原生 `branchSummary.skipPrompt` 开关、HTTP(S) 代理/空闲超时、WebSocket 连接超时、默认工具、Thinking 与图片处理、项目默认授权、Shell/npm/Session 目录、Skill 命令、警告及遥测开关。开启 `skipPrompt` 后，桌面分支对话框遵循 AgentCore 的无摘要路径并隐藏摘要选项。传输方式包含 `websocket-cached`。设置写入 AgentCore 自带锁定存储，保留未知及嵌套设置，既有代理凭据不传入 Renderer。项目覆盖仍优先；网络、Shell 和 Session 目录修改需重启，重试/压缩与资源设置可通过 `/reload` 加载，默认工具用于新会话。
- `SessionCapabilities.extensionShortcuts` 返回经过 AgentCore 原生冲突处理的扩展快捷键；`extensions.invokeShortcut` 先同步当前草稿，再以 AgentCore RPC context 执行处理器。`extensions.syncEditor` 按项目和会话镜像编辑文本，支持 `getEditorText`、`setEditorText`、`pasteToEditor`；模态窗口和输入法组合期间不触发扩展快捷键。
- 扩展 `getAllThemes`、`getTheme`、`setTheme` 在 PfsaaHost 中保留真实 AgentCore Theme 对象（含资源加载主题），只传递校验后的颜色和浅深色信息。主题覆盖按会话隔离，同时作用于工作区与浮层，可通过顶栏主题按钮清除。状态、文本 Widget、通知会移除终端 ANSI 控制符。

| AgentCore 能力 | PFSAA 入口 | 当前实现 |
| --- | --- | --- |
| 项目发现、浏览与移除 | 左侧项目树；多个项目可同时展开，单击项目只切换自身展开状态，右键项目可从列表移除；560px 以下通过顶部按钮打开带焦点约束的会话抽屉，并将背景设为 inert | `SessionManager.listAll()` + Main 有序/隐藏 `cwd` 清单 → `projects.list` / `projects.remove`；移除不删除项目文件或 AgentCore Session |
| 项目 AgentCore 资源授权 | 全局默认策略为 `ask` 时新增项目即询问；项目右键菜单 → 项目 AgentCore 资源；`/trust` | 以 AgentCore `hasTrustRequiringProjectResources()` + `ProjectTrustStore` 的项目保存、父目录继承或全局默认决定为准。没有项目保存或父目录继承决定的新项目也会询问一次，即使暂时没有受保护资源，所选决定仍覆盖以后新增的资源。PfsaaHost 将最终决定传入 `SettingsManager.create(..., { projectTrusted })`，实际控制项目设置、Extension、Skill、Prompt、主题、包、系统提示和项目 `.agents/skills` 的加载。修改当前空闲项目时重建并重载 Session；不会中断运行中的任务，任务结束后生效 |
| 会话列表与切换 | 展开任意项目后按最近更新时间倒序显示会话；只有单击具体会话才切换中央工作区 | `SessionManager.list(cwd)` / `updatedAt`；每个展开分组只从自身的 `projectTasksByCwd[cwd]` 缓存渲染，跨项目切换的中间帧不会借用前一项目的会话行 |
| 新建会话 | New task；展开无会话项目时的“新建任务”按钮；空状态按钮 | `SessionManager.create(cwd)` |
| 会话消息 | 中央对话线程 | 通过 AgentCore `sessionEntryToContextMessages()` 投影完整当前 `SessionManager.getBranch()`；`AgentSession.messages` 继续作为压缩后的模型上下文，重启后仍显示压缩前回合；按 AgentCore `parseSkillBlock()` 语义将 Skill 引用与用户原文分层展示 |
| 执行耗时恢复 | “已处理”执行摘要 | PfsaaHost 在 `agent_start`、Follow-up 分组边界和 `agent_settled` 记录 execution group，通过 `SessionManager.appendCustomEntry("pfsaa.execution-run", ...)` 将精确起止时间写入 AgentCore Session；Steering 仍合并为同一组，`sessions.runMetadata` 在重启后恢复，旧会话不伪造耗时 |
| 会话命名 | 会话列表与对话标题 | 首条用户消息后：先用 `deriveSessionTitle` 生成去前缀短标题并经由 `sessions.rename`（对应 AgentCore `AgentSession.setSessionName()`）持久化作为重载安全的回退；随后异步调用新增的 `sessions.generateTitle` 桥（PfsaaHost 用 `ModelRuntime.complete` 对首条消息做 3–8 词摘要），成功后将标题升级为 LLM 摘要并再次 `sessions.rename` 持久化。仅当标题仍是截断/占位名时才升级，手动改名不被覆盖；LLM 失败回退到截断标题 |
| 会话删除 | 会话更多菜单 | `sessions.delete(taskId, cwd)`；PfsaaHost 以规范化项目路径 + 会话 ID 标识运行时状态，不会影响其它项目导入的同 ID 会话 |
| 会话位置与长会话 | 中央对话线程（普通文档流 + 早期消息折叠） | 不使用虚拟列表；只挂载最近 200 条，更早消息折叠在"显示更早消息"按钮后。防跳动依赖 `overflow-anchor: auto` 原生 scroll anchoring；非活动 pane 用 `visibility: hidden` 天然保留 `scrollTop` 并暂停 DOM observer；follow 仅由真实 wheel/touch 上滑事件退出，程序化滚动期间 latch 住 |
| Provider 列表 | 快捷设置 → Provider 设置（搜索、认证状态筛选、新增、管理/编辑、移除） | `ModelRuntime.getProviders()` 和 `listCredentials()` 仍是唯一权威来源。PFSAA 仅在无凭据的 `runtime/.agent/pfsaa-provider-ui.json` 中记录自己创建的 Provider ID 与被隐藏的运行时条目；DTO 只携带脱敏后的生效认证来源、本机已存凭据标记和 PFSAA 自定义 Provider 所有权标记 |
| API Key / OAuth | Provider 设置（本机凭据、移除确认） | `ModelRuntime.login()`、`ModelRuntime.logout()`、AgentCore auth 回调。PFSAA 自建 Provider 可在 AgentCore 的 `runtime/.agent/models.json` 中管理多个 OpenAI Chat Completions 兼容模型，支持手动录入模型 ID，或由用户主动请求配置地址的 `/models` 端点并勾选候选项后保存；候选列表不会自动写入，也不维护第二套模型目录。创建和编辑都通过 `ModelRuntime.refresh({ allowNetwork: false })` 做本地验证，API Key 经 AgentCore 凭据路径保存。只有由 PFSAA 创建的 Provider 能连同本机凭据一起真正移除；内置、Extension 或外部配置的 Provider 只会从此设置页隐藏，并可恢复显示，不会伪装成已从 AgentCore 删除。失败会保留在确认对话框内并可直接重试。关闭设置会通过 `AuthInteraction.signal` 中止未完成的登录，新尝试会先替换同一 Provider 的遗留认证再重新打开浏览器；OpenAI Codex 浏览器登录会预检 AgentCore 0.84.2–0.85.1 的固定回调端口，手动输入回调地址仅作为显式兜底，成功后自动聚焦桌面窗口；PfsaaHost 在 Token 交换前按“显式环境变量 → AgentCore `httpProxy` → Electron 系统代理”的优先级初始化 AgentCore 的代理感知 HTTP dispatcher |
| 模型列表 | Composer 模型选择器 | `ModelRuntime.getModels()` |
| 思考等级 | Composer Thinking 菜单；`/thinking [level]`；`/settings` | `AgentSession.getAvailableThinkingLevels()` / `setThinkingLevel(..., { persist: true })`；模型选择同样使用 `setModel(..., { persist: true })`；Composer 与 AgentCore 设置中的思考选项均从 AgentCore 模型能力派生，全局及按模型启动默认值（`modelThinkingLevels`）均读写同一份 AgentCore 用户级 SettingsManager |
| 默认内置工具 | AgentCore 全局/项目 `settings.json`；PFSAA 不维护第二套目录 | PFSAA 不传入 `createAgentSession.tools`，由 AgentCore 应用 `defaultTools`，包括配置后可用的 Windows `powershell` 工具；Extension/自定义工具继续遵循 AgentCore runtime 语义保持启用 |
| AgentCore slash command catalog | 行首已知 `/` 前缀建议、快捷设置 → AgentCore 命令 | AgentCore 内置 catalog、Prompt、Skill、Extension command；路径和普通文本不触发命令建议 |
| `@file` 提示 | Composer `@` | `workspace.snapshot` 返回的当前工作区文件快照 |
| Agent 流式事件 | 中央线程 | `agent_start`、`agent_end.messages`、`agent_settled`、`message_update`、`tool_execution_*`、`ui_prompt_start/end` 等；PfsaaHost 将 Extension UI 提示生命周期归一化为可序列化 payload，实际输入仍由现有桌面请求桥负责 |
| Steering / Follow-up 队列 | Composer 队列面板与投递菜单 | `agent.queue`、`setQueueModes`、`clearQueue`、`promoteQueue`、`editQueue`、`deleteQueue`；正在运行的 prompt 触发自动上下文压缩时，期间提交的普通消息进入 AgentCore 官方 `steer()` / `followUp()` 队列，不会启动竞争的 `Agent.prompt`，Extension 命令则保持 AgentCore CLI 的立即执行行为；Host 侧预检门闩同时覆盖 AgentCore 尚未报告 `isStreaming` 的短暂窗口。批处理模式单选项展示 AgentCore 已确认的当前模式与请求中反馈，变更审查分栏挤压时队列入口保持单行，带稳定 ID 的条目展示图片缩略图，并支持原位重新编辑或删除任意待处理 Steering/Follow-up 项。由于 AgentCore 没有任意单项删除 API，PfsaaHost 会校验 sidecar 稳定 ID，再用 AgentCore 官方清空及按序重新入队 API 原子重建剩余队列，失败时恢复原队列；队列新增、编辑、删除、插入和处理在 follow 状态下自动跟随 |
| 工具审批 | 中央审批卡 | 当前 PfsaaHost `beforeToolCall` 适配 |
| 工具过程 | 运行中不可展开的耗时提示 + 按时间排序的 Activity feed；完成后可折叠过程块 | 执行期间摘要只显示耗时，下方以低强调度的行内信息流和统一会话间距，按 AgentCore 事件顺序交错显示思考块与工具调用；结束后完整过程进入可展开摘要。实时/完成态详情使用同一高度上限并在溢出时内部滚动；实时区域会跟随刷新及延迟尺寸变化，直到用户有意向上滚动，且不会改变外层对话的 follow 状态；完成后保留 Tool Result、工具名称及成功/失败状态 |
| 单轮文件变更审查 | Composer 摘要可打开可调宽面板或焦点受控抽屉；支持带日期/耗时/结果的无障碍轮次选择、筛选与目录聚合、完整方向键树导航、统一/Codex 风格拆分 diff、换行、仅空白过滤、轻量语法高亮、变更块导航与逐块接受/撤销、延迟加载的 CodeMirror 可编辑合并、增量行折叠、重命名/模式/二进制/截断状态、复制路径、可重试错误，以及跨重启按 Session 恢复轮次/文件/目录/尺寸/选项/滚动；撤销需确认，二进制/超大/截断 patch 保持只读；空排队轮次保留最近非空摘要 | PfsaaHost 在 `agent_start`/Follow-up 边界捕获 Git 工作树，变更工具后对预览去抖并取消过期扫描，settlement 时权威比较（包括本轮提交后的 HEAD 变化），并使用 AgentCore 公开的 `generateUnifiedPatch()`。运行前脏文件仅在本轮再次变化时计入；精确零模糊度反向 patch、项目内普通文件校验、逐文件修改锁、乐观 revision 校验、原子写入、元数据持久化失败回滚及处理结果持久化共同保护工作区修改；候选、文件、内容、patch、历史及 IPC 均有硬上限，导入数据严格清洗。一个最小 `pfsaa.change-review-store` custom-entry 锚点关联原子替换 sidecar，最多保留 20 轮/12 MB；列表 IPC 只传摘要与可用性，详情及合并源只加载所选文件；Host 优雅退出会等待最终写入。同一时段的外部工作树修改可能被包含，UI 会明确说明 |
| 用户 Shell 命令 | Composer `!command` / `!!command`；不恢复独立终端面板 | `AgentSession.executeBash()`；`!!` 排除输出进入模型上下文，停止操作调用 `abortBash()` |
| 上下文压缩 | Command Palette；`/compact [instructions]` | `AgentSession.compact()` 缩减后续模型上下文；手动压缩期间提交的输入继续在队列中可见、可编辑，并在压缩后按序恢复；桌面时间线继续显示完整持久化当前 Session 分支 |
| 重新加载资源 | `/reload` | 调用 `AgentSession.reload()` 重新加载 SettingsManager、Package、Extension、Prompt、Skill、Theme 与模型注册表；先清理已卸载扩展留下的展示状态，再让保留扩展接收新的 `session_start`，最后刷新桌面能力 |
| Session 导出 | Command Palette | `AgentSession.exportToJsonl()` / `exportToHtml()` |
| Runtime 状态 | Sidebar | Main/PfsaaHost runtime status event，以及脱敏的 `runtime.error` 启动失败信息 |
| 中英文 | 顶部显示目标语言的切换按钮（中文界面显示 `EN`，英文界面显示 `中`） | Renderer i18n |
| 浅色/深色 | 顶部主题按钮 | Renderer theme preference |
| 关于 PFSAA | 帮助 → 关于 PFSAA | 只显示 PFSAA 应用版本和当前 AgentCore runtime 版本 |
| 模型范围 | 快捷设置 → 模型范围 | 支持按 Provider/Model 搜索、整组全选/清空、顺序调整与单模型 thinking override；Composer 轮换直接调用 AgentCore `AgentSession.cycleModel()`，确保范围、顺序和 Thinking 以 AgentCore 为准；PfsaaHost 依据 ModelRuntime 校验并持久化 AgentCore 的 `provider/model[:thinking]` 模式，空列表表示不限制 |
| AgentCore 包资源与更新 | 快捷设置 → AgentCore 包 | 通过 AgentCore `DefaultPackageManager` 按明确的用户级或项目级作用域管理安装/移除/启停，查看并切换单个 Extension/Skill/Prompt/Theme 资源，检查和执行单包/全部更新，并刷新模型目录 |
| Extension 运行时上下文 | Extension 命令与 UI | Session 通过 `AgentSessionRuntime` 创建；命令获得 `ctx.mode = "tui"` 以及可用的 `waitForIdle`、`newSession`、`fork`、`navigateTree`、`switchSession`、`reload`，使按交互模式守卫 Header/Footer/编辑器注册的 AgentCore 扩展能够启用。Session 替换后重新绑定新身份，并显示加载/命令/快捷键诊断、模型回退、异步错误和 shutdown 请求 |
| Extension UI 生命周期 | 桌面对话框与展示面 | select/confirm/input/editor 支持取消与超时，dismiss 会关闭匹配对话框；AgentCore TUI 自定义组件、组件 Widget、Footer/Header 与自定义编辑器在 PfsaaHost 内渲染为有界的终端样式画面并接收按键桥接（`/llama` 使用该能力）；terminal input 保留 consume/rewrite 链，autocomplete provider 返回其实际应用后的文本和光标；通知级别、working indicator 帧间隔、工具展开、编辑器文本、状态、Widget 与标题均显式序列化 |
| 重试与摘要状态 | 运行中指示器 | AgentCore `auto_retry_*` 与 `summarization_retry_*` 事件显示尝试次数、最大次数、等待时间、摘要阶段、完成状态和最终可操作错误 |
| Composer 与会话输入 | Composer、当前会话搜索栏；AgentCore 设置 → 外部编辑器 | 支持用户提示历史、Tab/Enter 资源补全、AgentCore 外部编辑器、图片粘贴/拖放、包含折叠历史的会话匹配导航，并把 AgentCore 生效的 `keybindings.json` 适配到搜索、模型、thinking 和外部编辑器动作。AgentCore 设置页区分自动与自定义模式，显示当前命令来自项目设置、用户设置、`VISUAL`、`EDITOR` 还是 AgentCore 平台默认值，并可通过 Windows/macOS 原生应用选择器填充自定义命令。命令仍通过 AgentCore 自带的锁定 `FileSettingsStorage` 持久化，清空后恢复自动优先级；Unix 上带引号的已选路径在调用 AgentCore helper 前使用一次性无空格别名，因此无需第二套编辑器配置存储即可支持带空格路径 |
| Print/JSON/RPC/stdin/Auth Print | `npm run cli -- <AgentCore 参数>` 或 `pfsaa-cli`（`pfsaa-cli` 仅为兼容别名） | 透明委托给 AgentCore 官方 `main()`，复用其参数解析、stdin/stdout JSONL、Print/JSON/RPC、Session 与 `auth print-*` 语义，不实现第二套 Agent 或协议 |

## Slash 命令状态

桌面壳菜单不属于 AgentCore slash 命令：Windows 在“工作台”右侧提供编辑/查看/帮助，窄窗口合并为“菜单”；macOS 使用系统菜单栏。经校验的 `app:popup-menu` 桥打开现有 Electron 菜单，不增加 AgentCore 能力，也不重复实现原生编辑、缩放、全屏等操作。正式构建仍不显示重新加载和开发者工具。

快捷设置在精简首页展示设置入口，并将任务操作和 AgentCore 命令放入子页。AgentCore 命令页支持带斜杠和不带斜杠搜索；固定操作会替代等价 slash command 行，确保同一能力只出现一次。

顶栏齿轮与 `Ctrl/Cmd + ,` 打开快捷设置首页，`Ctrl/Cmd + K` 直接打开其中的 AgentCore 命令子页。缺少项目或 Session 时，相应入口禁用。macOS 与 Windows 的 Provider、AgentCore 设置和包管理抽屉均紧贴共享顶栏下方展开，使用紧凑头部；重复的顶部 Provider、顶部命令和侧栏命令入口继续保持移除，Composer 中的模型、思考与权限控件以及顶栏语言、主题控件仍然保留。

在快捷设置中点击或按回车选择内置命令，会立即调用已有桌面处理逻辑，不修改 Composer 草稿与附件；需要选择参数的命令直接打开已有选择器或对话框。Prompt/Skill 标明“插入模板”，仍可编辑后再提交。`SessionCapabilities.slashCommands[].source = "extension"` 标识运行时注册的扩展命令，通过 AgentCore 的 `agent.prompt` 命令通道直接执行；未知内置命令会显示未支持错误，不作为模型提示发送。连续打开的弹层关闭后会恢复到原工作区入口的焦点。

当前 Composer 会读取 AgentCore 的真实 slash command catalog，并为命令提供建议。命令的最终执行仍必须遵循 AgentCore CLI 语义：

- 已有明确 Bridge 的命令应调用对应 PfsaaHost 能力，例如 `/compact`、`/export`、`/model`、`/login`、`/logout`。
- 只有展示 catalog、但没有对应 Bridge 的命令不能伪装成已执行。
- `/skill:name` 由 AgentCore `AgentSession.prompt()` 负责展开；PFSAA 按 AgentCore TUI 的 `parseSkillBlock()` 规则仅显示紧凑 Skill 引用和用户实际输入，不把注入正文重复显示为用户消息。
- Extension command 的权威来源是当前 AgentCore `ResourceLoader`，不是静态 fallback。

当前已接入的桌面命令包括 `/settings`、`/reload`、`/import`、`/share`、`/copy`、`/name`、`/session`、`/changelog`、`/hotkeys`、`/trust`、`/resume`、`/quit` 和 `/scoped-models`。`/trust` 打开与项目右键菜单相同的项目级状态与授权界面；`/settings` 写入 AgentCore 自己的用户级设置；`/reload` 调用当前 AgentSession 的真实 reload API；`/import` 会打开 Electron 原生 JSONL 选择器，不接受 Renderer 提供的路径；`/share` 仍要求本机安装并登录 `gh` CLI。

`/fork`、`/clone` 与 `/tree` 已进入 Composer 建议和快捷设置，共用响应式 Session Tree 浏览器。默认显示对话节点，可切换全部技术事件，支持搜索、方向键导航、活动路径/当前位置/分叉点标记，以及操作前的节点影响预览。Fork 仅允许选择 AgentCore 支持的用户消息，并在新会话 Composer 恢复所选文本；clone 将当前叶节点复制为新会话；tree 保持当前会话，可选生成可取消的离开分支摘要。会话替换与时间线均重新绑定到 AgentCore 的权威会话标识。

## 权限与审批边界

当前 PfsaaHost 优先通过 AgentCore Extension 机制加载 `@gotgenes/pi-permission-system`：

- `allow`：自动允许工具执行。
- `ask`：由 AgentCore 权限系统产生审批请求，再由 PFSAA 审批卡响应。
- `deny`：阻止工具执行。
- `yoloMode`：自动批准 `ask`，用于全自动执行。

PFSAA 在输入框下方提供当前权限级别切换，并写入插件的 AgentCore 配置文件。切换不会中断正在运行的 Agent；空闲 Session 会在下一次提示前按新策略惰性重建。Extension 不可加载时才回退到 PfsaaHost `beforeToolCall` 适配。

当前审批事件只提供工具名和参数，没有独立的风险等级字段；审批卡因此明确标记为“工具调用”，不会根据工具名伪造风险等级。

## 已接入的扩展能力

以下能力已经完成基础桌面映射：

- Extension UI 的 select、confirm、input、editor、notify，以及可序列化的状态、工作文案/可见性/动画、隐藏思考标签、文本/组件 Widget、Footer/Header、标题与编辑器文本；TUI 自定义组件和 editor component 会在 PfsaaHost 渲染为有界的终端样式画面并接收按键桥接，terminal input 与 autocomplete provider 也保留 AgentCore 的处理语义，AgentCore 原生 `/llama` 可直接使用。
- AgentCore package install/remove/update/config 管理器；快捷设置提供唯一入口。
当前边界：组件实例不会跨进程，而是在 PfsaaHost 内渲染并只传递有界纯文本画面；因此依赖像素级终端能力或任意 DOM 的扩展仍应使用 AgentCore CLI。PFSAA 不嵌入独立 CLI 面板，单独的兼容入口仍委托给 AgentCore 官方 `main()`。

任务基线统一 diff 审查、逐块接受/撤销和可编辑合并已经接入；staging 与提交编排仍不属于审查界面。

新增能力必须先更新 `packages/contracts`，再更新 PfsaaHost、Preload、Renderer 和本文矩阵。
