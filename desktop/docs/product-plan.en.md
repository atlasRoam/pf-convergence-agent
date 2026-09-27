# PFSAA Product and Technical Plan

> PFSAA fork: the current milestone is an unaccepted development integration of
> PFSAA's external SDK with PFSAA's existing Host, not a packaged release.
> Its fixed paths, supported core flow and Windows acceptance are documented
> in [PFSAA.md](../PFSAA.md); the upstream feature plan below remains background.

> Document status: aligned with the current code baseline; unimplemented items are explicitly marked as planned.
>
> Last updated: 2026-09-23
>
> Target platforms: Windows, macOS

## 1. Product Positioning and Boundaries

PFSAA is a desktop UI adaptation layer for `@earendil-works/pi-coding-agent`. It does not reimplement agents, models, session storage, credentials, or tooling; it maps the local capabilities of the AgentCore runtime/CLI onto a desktop workspace.

Explicitly out of scope:

- A second agent, model catalog, credential store, or message database.
- Product capabilities not supported by the AgentCore runtime/CLI.

Provider API keys, OAuth, token refresh, and session files remain managed by the AgentCore Runtime. An API key is held transiently by the settings form only when entered and submitted, then persisted by AgentCore through PfsaaHost; PFSAA does not persist credentials in its own UI state or model catalog.

## 2. Current Implementation Baseline

AgentCore runtime baseline: `@earendil-works/pi-coding-agent@0.85.1`. PFSAA leaves `createAgentSession.tools` unset, so AgentCore applies its project/global `defaultTools` setting—including the optional Windows `powershell` tool when configured—while keeping Extension and custom tools enabled. Model summaries omit thinking levels that AgentCore explicitly maps to `null`; active sessions continue to use the authoritative `AgentSession.getAvailableThinkingLevels()` result. Model and thinking changes persist through AgentCore's user settings because PFSAA calls `setModel()` / `setThinkingLevel()` with `{ persist: true }`; `/thinking [level]` maps to the desktop thinking selector. The `/settings` sheet edits the same user-wide defaults through `SettingsManager`. AgentCore's `ui_prompt_start` / `ui_prompt_end` events are normalized as serializable Agent events, while PFSAA's richer queue mutations continue to use the direct `AgentSession` queue API (the SDK's RPC `clear_queue` remains outside the desktop's direct-host transport). AgentCore 0.85.1's GPT-6 Astra catalog is consumed dynamically through `ModelRuntime`; its fork-compaction, branch-summary, import, proxy, Qwen catalog, and OpenAI Codex SSE fixes therefore flow through the existing desktop mappings. Provider settings can add and edit PFSAA-owned OpenAI Chat Completions-compatible Providers with multiple model definitions in AgentCore's existing `runtime/.agent/models.json`; users may enter model IDs manually or explicitly fetch candidates from the configured `/models` endpoint, then choose which ones to persist. Configuration is validated through `ModelRuntime` without a remote catalog refresh, and API keys are persisted by AgentCore's credential store. PFSAA only records custom-Provider ownership and hidden authentication-page entries, without credentials, in `runtime/.agent/pfsaa-provider-ui.json`.

Pre-existing OpenAI Chat Completions-compatible entries in that same local `models.json` can also be edited and refreshed; editing eligibility is separate from PFSAA-created deletion ownership. Providers without a supported local configuration remain managed by their originating runtime or extension.

Adding models to a Provider remains available while a loaded Session uses it. Changing its URL or removing a selected model waits until the affected Session switches models.

Project AgentCore resources follow AgentCore's trust model rather than treating “opened” as implicit trust. When protected project settings, Extensions, Skills, Prompts, themes, packages, system prompts, or project `.agents/skills` exist, PFSAA reports the effective saved/inherited/default decision and passes it to `SettingsManager.create(..., { projectTrusted })`. Adding an unresolved project under the `ask` policy opens the decision UI; the same project-scoped entry remains in the project context menu.

Current runnable topology:

```text
React Renderer
  → Preload contextBridge(window.pfsaa)
  → Electron Main IPC
  → child_process.fork(PfsaaHost)
  → Electron bundled Node (ELECTRON_RUN_AS_NODE)
  → @earendil-works/pi-coding-agent
```

The current code is neither Electron `utilityProcess` nor MessagePort. `packages/pfsaa-host` uses plain Node `process.send/process.on("message")`. PfsaaHost runs in Electron's bundled Node (which satisfies the AgentCore runtime Node engines and can read the asar transparently); node_modules stay packed in the asar, with only native `.node` modules and `apps/desktop/assets` unpacked.

### 2.1 Current Layout

```text
apps/desktop/
├─ index.html                    # Vite Renderer host page
├─ vite.config.mts               # Renderer ESM build config, outputs to dist-renderer/
├─ assets/ · native/ · public/   # Icons, macOS native customization source, static assets
├─ scripts/                      # build-native.mjs, renderer-regressions.test.cjs
└─ src/
   ├─ main/index.ts              # Main, application menu, and IPC orchestration
   ├─ preload/index.ts           # contextBridge
   └─ renderer/
      ├─ App.tsx                 # Entry and composition
      ├─ main.tsx                # Renderer mount entry
      ├─ app-view.tsx            # Workspace shell and global layout
      ├─ app-sidebar.tsx         # Project/Session sidebar
      ├─ app-conversation.tsx    # Session pane and Composer
      ├─ app-overlays.tsx        # Quick settings and dialog overlays
      ├─ use-app-controller.tsx  # State and action orchestration
      ├─ use-session-data.ts     # Session data loading
      ├─ use-runtime-events.ts   # PfsaaHost event normalization
      ├─ use-conversation-scroll.ts # Scroll snapshots and latest position
      ├─ use-stream-deltas.ts    # Bounded streaming-delta batching
      ├─ use-global-shortcuts.ts # Global shortcuts and focus boundaries
      ├─ use-preferences.ts      # Language and theme preferences
      ├─ use-notice.ts           # Lightweight notice state
      ├─ use-sent-images-cache.ts # Pending-send image cache
      ├─ timeline-utils.ts       # Turn grouping and execution summaries
      ├─ message-utils.ts        # Message merging and identity
      ├─ types.ts                # Renderer state and helper types
      ├─ image-cache.ts · agentcore-capabilities.ts · styles.css · vite-env.d.ts
      └─ ui/                     # Timeline, message, Composer, hierarchical Quick settings, dialog, settings components

packages/
├─ contracts/                    # Bridge/IPC types, type-only package without dist
├─ domain/                       # Types and shared domain helpers
├─ agentcore-adapter/                   # AgentCore runtime resolution, loading, and public API adaptation
├─ pfsaa-host/                      # PfsaaHost process entry
├─ permission-engine/            # Permission configuration and approval adaptation
├─ i18n/                         # zh/en copy
└─ ui-system/                    # Shared Renderer UI primitives
```

For the complete boundary, see [current architecture](architecture.en.md).

## 3. Current User Flows

Currently supported:

1. Start PfsaaHost and show runtime status.
2. Auto-discover projects that own AgentCore Sessions, remember manually added project directories, and support hiding directory references via the project context menu (without deleting files or Sessions).
3. Expand multiple projects' session lists at once; project expansion states and Session-row caches are `cwd`-scoped, so cross-project switches never render the previous project's rows under the new project. The central workspace switches only when a specific session is clicked. Projects without sessions can create their first Session directly in the expanded area; creating, switching, and deleting local Sessions are supported.
4. Read and display Session messages.
5. Select an authenticated Provider/Model and thinking level.
6. Send prompts, view streaming replies, and stop runs.
7. View tool calls, tool results, and approval cards.
8. Reference workspace files via `@file`.
9. Compact context and export JSONL/HTML; import AgentCore JSONL sessions, rename, and view session stats.
10. Use AgentCore slash command catalog, Prompt, Skill, and Extension command suggestions.
    Quick settings keeps a compact root and moves task actions and searchable AgentCore commands to child pages; `Ctrl/Cmd + K` opens the command child directly, while the header gear and `Ctrl/Cmd + ,` open the root. Commands execute on click/Enter, and templates remain explicitly labeled and editable. Settings drawers open below the shared toolbar with compact headers and restore focus across chained overlays.
11. Authenticate locally with Provider API keys/OAuth; add, edit, or remove PFSAA-created OpenAI Chat Completions-compatible services and manage multiple models per service. Model IDs can be entered manually or fetched on explicit request from the configured `/models` endpoint through PfsaaHost; only selected results are saved. Built-in, Extension, and externally configured services can be hidden from this authentication page and restored later, but their underlying AgentCore/external definition is not falsely deleted. OpenAI Codex browser login uses AgentCore's loopback callback by default, exposes manual callback entry only as a fallback, and refocuses PFSAA after success. Closing Provider settings aborts an unfinished OAuth operation, so a later attempt starts a fresh browser flow. PfsaaHost network calls honor explicit proxy environment variables, AgentCore's global `httpProxy`, and the cross-platform system proxy in that order.
12. Switch Chinese/English and light/dark themes.
    Windows exposes native Edit/View/Help menus after Workspace (one Menu button on narrow windows); macOS keeps the system menu bar. Existing native actions, edit selection, keyboard access, and localized labels are reused.
13. Use Steering/Follow-up queues, including AgentCore-native queueing for prompts submitted during a running prompt's automatic compaction, batch mode with checked current-mode and in-flight feedback, and a compact Composer-attached queue stack with image thumbnails, promotion, re-editing in the original queue position, and deletion of any pending row; the queue trigger remains single-line and available when change review compresses the conversation pane.
14. Use a plain document-flow list with earlier-message folding for long sessions (only the most recent 200 messages stay mounted; older ones fold behind a "show earlier" button), caching message panes, scroll positions, and follow state per Session.
15. Desktop mappings of `/copy`, `/share`, `/changelog`, `/hotkeys`, `/trust`, `/resume`, `/quit`, and `/scoped-models`; project AgentCore-resource trust is also available from the project context menu, and a new project without a saved/inherited decision is asked once under the default `ask` policy; `/share` requires a local `gh` CLI.
16. Persist precise per-run start/end times in AgentCore Session custom entries so "processed" durations stay consistent across restarts.
17. Review each run's bounded Git worktree changes from the Composer summary in a responsive, accessible pane with lazy detail loading, run/file/tree restoration, filtering, unified/Codex-style split diff options, hunk navigation, per-hunk accept/revert, editable merge, and explicit availability/error/truncation states.
18. Configure an ordered scoped-model list with per-model thinking levels; manage individual AgentCore package resources, check/update packages, and refresh the model catalog from the same AgentCore runtime.
19. Use prompt history, Tab/Enter resource completion, AgentCore's configured external editor, pasted or dropped images, AgentCore-configured model/thinking/search/editor shortcuts, and a current-session transcript search that can reveal folded messages. AgentCore settings separates automatic precedence from a custom user command, shows the effective source, and can populate the command through the operating system's application picker (Windows executables and macOS applications/executables). The selected command is still persisted through AgentCore's locked settings storage; clearing the override restores automatic precedence. PfsaaHost aliases quoted absolute paths on Unix only for the lifetime of an edit so AgentCore's external-editor helper can launch selected applications whose paths contain spaces.
20. Run AgentCore's headless compatibility surface through `npm run cli -- <args>` / `pfsaa-cli`; `pfsaa-cli` is the PFSAA compatibility CLI. The wrapper delegates Print, JSON, RPC, stdin JSONL, and Auth Print behavior directly to AgentCore's official `main()`.

## 4. Message and Conversation Behavior

- AgentCore's raw Session messages are the source of truth.
- The Renderer never receives AgentCore runtime instances; only serializable message objects are passed to components.
- Markdown, code blocks, tables, and links are rendered in the Renderer presentation layer without altering AgentCore's raw messages.
- Session titles avoid embedding full Skill text; after the first user message, the title first uses a reload-safe truncated fallback, then asynchronously upgrades to a 3–8 word LLM summary of the first message (new `sessions.generateTitle` bridge: PfsaaHost summarizes with `ModelRuntime.complete`, then persists via `sessions.rename`). Manual renames take precedence over LLM upgrades. PFSAA keeps the Skill reference compact and separate from the user's actual follow-up; it does not re-display the injected Skill body as a normal user message.
- Completed tool calls and thinking render as collapsible activity blocks showing tool count, thinking-block count, and duration. While a run is active, its summary is only a non-expandable elapsed-time indicator; the low-emphasis inline Activity flow interleaves thinking blocks and tool calls chronologically, keeps each tool's arguments/results expandable, renders thinking as Markdown, and compacts excessive blank lines. Turn, continuation, and Activity-to-response spacing use a shared conversation rhythm. After settlement, the complete process moves into the expandable summary. Live and completed detail regions share a bounded height and scroll internally on overflow. The live region follows refreshed and late-resizing content to its newest output until an intentional upward wheel/touch gesture pauses it; returning to the inner bottom resumes following. Scrolling a process region remains isolated from the outer transcript follow state and never triggers its "jump to latest" control.
- AgentCore's raw thinking/tool content is used to rebuild the step content of "processed" summaries; exact durations come from `pfsaa.execution-run` metadata written by PfsaaHost via `SessionManager.appendCustomEntry()` at `agent_start`, Follow-up group boundaries, and `agent_settled`; Steering messages share the same execution group. Runtime `completedActivity` is still not a persisted field; old sessions without metadata only show "processed" and never infer durations from message timestamps.
- Session reloads project the complete active `SessionManager.getBranch()` for the desktop transcript. `AgentSession.messages` remains the separate compaction-aware model context, so compacting reduces future prompt context without hiding persisted earlier turns after PFSAA restarts.
- Per-run change review captures the Git worktree at `agent_start` and Follow-up boundaries, keeps Steering in the same group, debounces/cancels superseded previews, compares settlement authoritatively (including HEAD changes), and generates patches with AgentCore's public `generateUnifiedPatch()`. Existing dirty files are attributed only when their bytes/mode/path change during the interval; concurrent external edits can also be included and are disclosed in the UI. Candidate scans, baseline bytes, files, patches, retained history, mounted rows, view caches, and IPC are bounded. Strictly validated records live in an atomically replaced 20-run/12-MB sidecar referenced by one minimal AgentCore custom-entry anchor; list IPC returns summaries and selected details load lazily. The accessible pane/drawer provides filtering, aggregate keyboard tree navigation, unified/split and wrap/whitespace options, syntax highlighting, hunk navigation and resolution, CodeMirror editable merge, row folding, rename/mode/binary/truncation and retry states, plus restart-safe per-Session run/file/tree/split/options/scroll restoration. Destructive reverts require confirmation; writes are atomic and rejected when the file changed after the editor opened. An empty queued Follow-up does not hide the newest non-empty Composer summary.
- Thinking summaries, streaming replies, and final Assistant messages reuse stable timeline items, avoiding unmount/rebuild of the whole message list when a reply completes. Multiple Assistant commentary records in one turn keep unique identities and the shared continuation rhythm through the transition into live Activity instead of stacking full standalone-message gaps or hidden status placeholders.
- Switching Sessions immediately jumps to the session's latest or saved position without cross-session scroll animations.
- When the user manually leaves the bottom, a "jump to latest" affordance appears; scroll position is never force-restored.
- Queue message additions, insertions, edits, deletions, and processing auto-scroll only while the user is still following; scrolling up exits follow immediately. Queue entries are presented as a compact inset stack attached to the Composer and expose PfsaaHost-held image thumbnails. Editing or deleting any row validates its stable ID and atomically rebuilds the remaining AgentCore queue through `clearQueue()` plus ordered `steer()`/`followUp()` calls, restoring the original queue if rebuilding fails.
- Automatic retry and summarization retry events are preserved as explicit working phases with attempt count, delay, completion, and final failure feedback. Extension-driven Session replacement rebinds the Renderer to AgentCore's new Session identity instead of leaving stale task state behind.

## 5. Current Bridge Contract

`packages/contracts/src/index.ts` is the single authoritative definition. Main capabilities:

```text
app.setLanguage/setWindowTheme/quit
runtime.status
projects.list/chooseDirectory/remove/trustStatus/setTrust
sessions.list/create/delete/remove/messages/runMetadata/changeReviews/changeReview/capabilities/compact/export/import/rename/generateTitle/stats/share/changelog
models.list/refresh
workspace.snapshot
input.keybindings/externalEdit
settings.get/update/chooseExternalEditor
providers.list/listHidden/discoverModels/create/update/remove/restore/login/cancelLogin/logout/setApiKey/resolveAuth/openAuthUrl
agent.prompt/abort/setThinkingLevel/setModel/cycleModel/setScopedModels
agent.queue/setQueueModes/clearQueue/promoteQueue/editQueue/deleteQueue
approvals.resolve
events.subscribe
extensions.resolveUi
packages.list/install/remove/update/configure/configureResource/checkUpdates
permissions.status/setMode
```

Renderer → Preload → Main → PfsaaHost is the only communication path. New IPC must update contracts first, then Main, Preload, and Renderer.

## 6. Slash Command Strategy

The authoritative slash command catalog comes from the AgentCore ResourceLoader/SDK; fallbacks are used only when runtime resources are unavailable.

Commands currently mapped or to be mapped to native UI:

- `/login`, `/logout` → Provider settings.
- `/model` → model selector.
- `/compact` → `AgentSession.compact()`.
- `/export` → AgentCore Session HTML/JSONL export.
- `/new` → create Session.
- `/reload` → reload AgentCore resources / re-read initial data.
- `/import`, `/name`, `/session`, `/share` → PfsaaHost session import through Electron's native JSONL picker, naming, stats, and GitHub Gist sharing.
- `/copy`, `/changelog`, `/hotkeys`, `/resume`, `/quit` → Renderer/Electron desktop operations.
- `/trust` → the project-scoped AgentCore-resource status and decision UI backed by AgentCore `ProjectTrustStore`; the same UI is available in the project context menu and during new-project onboarding under the default `ask` policy.
- `/scoped-models` → AgentCore model scoping.
- `/fork`, `/clone`, `/tree` → unified responsive Session Tree browser with search, conversation/all-event filtering, keyboard navigation, current/active/branch markers, selected-node previews, optional abortable abandoned-branch summaries, and authoritative Session replacement/timeline restoration.

Commands without a stable Bridge must not be executed by the model as plain prompts, nor be faked as completed. The UI should show an actionable "not yet supported on the desktop" message.

`/skill:name` must go through `AgentSession.prompt()`; AgentCore runtime handles Skill expansion. PFSAA renders only a compact Skill reference and keeps the optional user follow-up separate from the injected body.

## 7. Permissions and Approvals

### 7.1 Current Implementation

PfsaaHost currently adapts via `AgentSession.agent.beforeToolCall`:

- `read`, `grep`, `find`, `ls` are allowed by default.
- Other tools go to the PFSAA approval card.
- User denial returns a blocked result.

### 7.2 `@gotgenes/pi-permission-system` Status

PFSAA has `@gotgenes/pi-permission-system@31.1.1` as an Extension dependency of the desktop PfsaaHost, loaded via AgentCore `DefaultResourceLoader.additionalExtensionPaths`. It keeps the same flat `permission` / `yoloMode` configuration consumed by PFSAA while adding directional path surfaces, fail-closed handling for unresolved Bash parses and redirects, session-keyed permission services, and dynamic tool-surface filtering. PFSAA does not consume the extension's removed root-service accessor or exhaustively switch on its decision-attribution values. The desktop offers these modes:

- `allow`: silently allow tool execution.
- `ask`: AgentCore's permission system requests approval before execution.
- `deny`: block tool execution.
- `yolo`: enables the plugin's `yoloMode`, auto-approving `ask`, for fully automated execution.

Settings changes write to the plugin's global AgentCore configuration and are shown in the permission-level control below the input. Switching does not interrupt a running agent; idle Sessions are lazily rebuilt under the new policy before the next prompt. When the Extension cannot load, PfsaaHost falls back to the built-in `beforeToolCall` approval adapter.

Integration constraints:

1. Load the real package in PfsaaHost via the AgentCore Extension mechanism.
2. Keep the plugin using its own AgentCore config directory and schema.
3. Map `allow/ask/deny` and `yoloMode` to read-only state/settings UI.
4. Normalize the plugin's approval and decision events into contracts.
5. Remove duplicate PFSAA custom approval gates to avoid two approval flows per tool call.
6. Verify allow, ask, deny, session approval, and failure-close behavior through real tool calls.

## 8. Current Boundaries and Planned Work

Still planned, not current product promises: staging and commit orchestration remain outside the change-review surface.

Extension component Widgets, terminal input, synchronous editor components, autocomplete providers, Footers, Headers, and interactive `custom` components are adapted through a bounded serializable screen/input bridge (used by `/llama`). Component instances stay inside PfsaaHost rather than crossing processes. Live editor text, registered shortcut execution, and AgentCore theme color adaptation are implemented.

The current parity baseline additionally includes manual compaction cancellation without automatically running staged prompts, `/model provider/model`, explicit `/export path` with native save confirmation, and advanced retry/compaction/proxy/timeout/default-tool settings persisted through AgentCore's locked storage. See the [feature matrix](agentcore-feature-matrix.en.md#command-settings-and-extension-parity) for exact behavior and restart requirements.

## 9. Technical and Security Constraints

- Node.js `>=22.19.0`, satisfying the current AgentCore runtime engines.
- Renderer must not use Node builtins, the AgentCore runtime, Credentials, or arbitrary IPC.
- Main handles only windows, IPC orchestration, and PfsaaHost lifecycle.
- PfsaaHost owns the AgentCore runtime, Agent, Tool, Provider, Session, and resources.
- Cross-process messages carry only JSON/structured-clone serializable DTOs.
- External URLs are limited to HTTP(S) and open in the system browser.
- The Renderer enforces a restrictive Content Security Policy and rejects in-window navigation.
- Packaged builds load the bundled, lockfile-pinned AgentCore runtime unless `PFSAA_RUNTIME_MODULE` explicitly overrides it.
- API keys and OAuth tokens never enter the Renderer, logs, events, or DevTools.
- PfsaaHost installs AgentCore's version-matched proxy-aware HTTP dispatcher before becoming connected; explicit environment configuration wins over AgentCore `httpProxy`, which wins over Electron's system-proxy fallback.
- Failure states must be visible and offer retry or repair actions.

## 10. Acceptance Commands

Run after any change to dependencies, contracts, PfsaaHost, Providers, Sessions, or core Renderer interactions:

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
# Requires configured credentials; runs the real GPT-5.5 transport matrix.
npm run acceptance:network
```

The transport-specific cells and cleanup guarantees are documented in the [network acceptance matrix](network-acceptance-matrix.en.md).

Release tags must resolve to a commit contained in `main`; the workflow pins that SHA, runs the same verification on Linux, then builds the Windows x64, macOS arm64, and macOS x64 installers on matching native GitHub runners. It generates a separate SBOM from each final package and creates a draft release with SHA-256 checksums; trusted public distribution additionally requires platform signing and macOS notarization secrets in the protected `release-signing` Environment.

PfsaaHost-related changes additionally verify:

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
agent.queue
agent.deleteQueue (missing stable ID must fail without mutation)
workspace.snapshot
```

## 11. Development Notes

For development boundaries, code conventions, dependency management, and acceptance requirements, see [AGENTS.md](../AGENTS.md).
