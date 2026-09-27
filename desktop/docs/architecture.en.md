# PFSAA Current Architecture

> PFSAA fork: Main fixes the external SDK to `../source/packages/agentcore-cli/dist/index.js`,
> starts PfsaaHost in `../runtime/`, and shares `../runtime/.agent/sessions` with the CLI.
> Host loads only PFSAA's Guard and two injected Skills, accepts one runtime
> workspace, and returns empty workspace snapshots without scanning private
> files. The general-purpose architecture below describes upstream PFSAA;
> development/packaging restrictions are in [PFSAA.md](../PFSAA.md).

> This document describes only what is implemented in the current repository, not a target architecture.
> For target plans and follow-ups, see the [product and technical plan](product-plan.en.md).

## 1. Product Boundary

PFSAA is a desktop adaptation layer for `@earendil-works/pi-coding-agent`: the Renderer handles interaction and presentation, while PfsaaHost owns AgentCore Session, ModelRuntime, Agent, Tool, Provider, resources, and CLI compatibility capabilities.

PFSAA does not provide:

- A second agent, model catalog, credential store, or session database.
- Node.js, filesystem, Shell, or AgentCore runtime access from the Renderer side.

Provider API keys, OAuth, and other credentials remain stored by the AgentCore Runtime in the local AgentCore config directory. PFSAA may create and edit OpenAI Chat Completions-compatible Providers with multiple model definitions in AgentCore's existing `models.json`, including pre-existing local entries; its small `pfsaa-provider-ui.json` sidecar contains only PFSAA-created deletion ownership and authentication-page visibility state, never a credential or duplicate model catalog. Model discovery is an explicit user action that requests the user-configured `/models` endpoint through PfsaaHost; results are suggestions until selected and saved.

`SessionCapabilities.changeReviewEnabled` is the Host-provided gate for the
per-run Git review surface. The fixed PFSAA runtime returns `false`, so the
Renderer does not request review data or render an unavailable launcher/drawer.
Provider summaries expose only a sanitized effective authentication source and
whether a local credential exists; they never include credentials or
environment-variable names. When the user explicitly saves an API key, the
typed request carries it to PfsaaHost for immediate persistence through
AgentCore; the PFSAA UI-state sidecar never stores it.

## 2. Current Runtime Topology

```text
Sandboxed React Renderer
  └─ Preload: window.pfsaa
      └─ Electron Main
          ├─ BrowserWindow lifecycle
          ├─ IPC handler orchestration
          └─ child_process.fork(PfsaaHost)
              └─ Electron bundled Node (ELECTRON_RUN_AS_NODE)
                  └─ @earendil-works/pi-coding-agent
```

The current implementation uses plain Node `child_process.fork` with `process.send/process.on("message")` — not Electron `utilityProcess`, not MessagePort. The fork targets the Electron executable itself with `ELECTRON_RUN_AS_NODE=1`, i.e. Electron's bundled Node: when the bundled Node satisfies the AgentCore runtime engines there is no WebIDL/undici compatibility issue, and it reads the asar archive transparently, so node_modules are fully packed into the asar with only native `.node` modules and `apps/desktop/assets` unpacked via `asarUnpack`. If the bundled Node is below the AgentCore runtime requirement, an external system Node must be used with node_modules fully unpacked (a system Node cannot read asar).

The headless `pfsaa-cli` / `npm run cli -- <args>` entry follows a separate direct path: `packages/pfsaa-host/dist/cli.js` loads the selected AgentCore runtime and calls AgentCore's official `main(args)`. `pfsaa-cli` is the PFSAA compatibility CLI. Print, JSON, RPC, stdin JSONL, and Auth Print therefore retain AgentCore's own stdout/stderr and protocol semantics without entering the Renderer/Main IPC topology.

Two runtime resolution entry points:

- `PFSAA_NODE_EXECUTABLE`: explicitly sets the Node executable used by PfsaaHost; defaults to `process.execPath` (Electron bundled Node).
- `PFSAA_RUNTIME_MODULE`: explicitly sets the AgentCore runtime entry file. Packaged builds otherwise require the lockfile-pinned SDK inside `app.asar`. Development resolves the repository's lockfile-pinned dependency before optionally falling back to a global AgentCore installation, preventing an unrelated older global CLI from silently changing the API surface.

`packages/pfsaa-host` posts messages to both `process.send` and the `worker_threads` `parentPort`, so the process host can be swapped, but Main currently only uses `child_process.fork`.

### 2.1 Main

`apps/desktop/src/main/index.ts`

Main is only responsible for:

- Creating and destroying the BrowserWindow (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
- Starting, listening to, and stopping PfsaaHost. Lifecycle callbacks are bound to the process instance that emitted them, so a late `exit` from a replaced Host cannot tear down its replacement; restart resolves only after a real `runtime.status` IPC round trip.
- Resolving the operating-system proxy through an internal Main/PfsaaHost bridge for each request URL when neither explicit proxy environment variables nor AgentCore `httpProxy` are set.
- Orchestrating between Renderer IPC and PfsaaHost requests.
- Setting timeouts for requests (default 60s; `providers.login`, `sessions.share` 15min; `packages.*` 10min; `agent.prompt` and `input.externalEdit` unbounded because completion is externally/event driven) and handling Host disconnects.
- Opening protocol-validated HTTP(S) URLs in the system browser and rejecting in-window navigation.
- Recording project directory references, hidden references, and their display order in Electron `userData/projects.json`.
- Building the application menu and switching menu language via `app:set-language`; copy comes from `@pfsaa/i18n`.
- On Windows, Electron Window Controls Overlay keeps the themed Renderer surface behind the system controls. Edit/View/Help triggers follow the Workspace label and reuse the native application menu; below 1100px they collapse into one Menu button. At 560px and below, actions move to a second toolbar row to preserve the native 48px caption-control hit area. Settings drawers start below the complete toolbar (normally 48px, 96px in the narrow Windows layout). macOS keeps its system menu bar. `app:set-window-theme` synchronizes the native background/control-symbol colors with the Renderer theme.
- `app:popup-menu` is a trusted Main-only IPC endpoint, exposed as `PfsaaBridge.app.popupMenu({ menu, x, y })`. Its strict contract allows only all/edit/view/help and finite bounded CSS-pixel anchors. Main resolves the existing native menu by stable ID, scales/clamps coordinates to content bounds, and resolves after dismissal; Renderer never sends menu actions or executable templates. Pointer activation preserves edit selection; keyboard activation restores the previous content focus before opening and returns to the trigger on dismissal. Failures surface a localized retry/restart notice.
- Opening native dialogs for directory picking, session import, and external-editor application selection. Main validates a selected executable (or a macOS `.app`) and returns only a AgentCore-compatible command string; the Renderer never receives general filesystem access.
- Setting the Dock icon on macOS and attempting to load `pfsaa-miniwindow.node` for the minimized-window icon; failures degrade to a warning.

The project directory list stores only `cwd`, never Session or workspace content. Clicking a project in the Renderer expands its session list on demand via `sessions.list(cwd)`, keeping other projects' expansion states independent and leaving the central session untouched; only clicking a specific session switches the workspace. Every expanded group renders from its own `projectTasksByCwd[cwd]` cache, so the intermediate render of a cross-project switch cannot place the previous project's Sessions under the newly selected project. Right-click "remove" on a project only adds `cwd` to hidden references and never deletes project files or AgentCore Sessions. Main never creates `AgentSession`, never stores Provider credentials, and never executes user Shell commands.

### 2.2 Preload

`apps/desktop/src/preload/index.ts`

Preload exposes a capability-scoped `window.pfsaa` via `contextBridge`. The Renderer can only use the capabilities declared in contracts; it never gains access to the raw `ipcRenderer`, Node objects, or Credential objects.

### 2.3 PfsaaHost

`packages/pfsaa-host/src/index.ts`

PfsaaHost is responsible for:

- Orchestrating `@pfsaa/agentcore-adapter`, SessionManager, AgentSession, and ModelRuntime.
- Resolving project AgentCore-resource access through AgentCore `ProjectTrustStore` and `hasTrustRequiringProjectResources()`, then constructing project `SettingsManager` and `ResourceLoader` instances with the effective saved, inherited, or default trust decision.
- Reading/restoring AgentCore Sessions, projecting the complete active `SessionManager.getBranch()` as the desktop transcript while leaving `AgentSession.messages` as AgentCore's compacted model context, and writing `pfsaa.execution-run` run metadata via `SessionManager.appendCustomEntry()`.
- Forwarding Agent events, Approval events, Auth events, and Extension UI requests. The orchestration entry remains in `index.ts`; process-local registries are isolated in `host-state.ts`, and AgentCore Agent event-to-bridge normalization is isolated in `agent-event-adapter.ts` so later domain splits can preserve the current IPC contract.
- Owning AgentCore `AgentSessionRuntime` so Extension commands receive a TUI-capable mode, official command-context actions, Session replacement/rebinding, diagnostics, async errors, shutdown requests, and cancellable/timeout-bound Extension UI requests; components still render in PfsaaHost rather than entering the Renderer.
- Executing AgentCore built-in tools, Bash, Provider login, AgentCore package management, permission-mode reads/writes, and session operations.
- Editing the existing AgentCore `models.json` atomically for locally configured OpenAI Chat Completions-compatible Providers, including pre-existing entries, supporting multiple model definitions and preserving existing per-model settings when IDs remain selected. An explicit model-discovery action requests the configured OpenAI-compatible `/models` endpoint through PfsaaHost with a bounded response, timeout, and no redirect; returned IDs/names are only saved after selection. Manual model entry remains available. Configuration edits refresh the real `ModelRuntime` without catalog-network access, and submitted keys use AgentCore's existing login/credential path. It may truly remove only a PFSAA-owned definition; other runtime entries are hidden from the authentication page and remain restorable.
- Reading AgentCore's effective keybindings and invoking AgentCore's configured external-editor helper for the Renderer input adaptation; the AgentCore settings surface reads the effective command/source and writes the user command through AgentCore's locked `FileSettingsStorage`. AgentCore splits editor commands on spaces before spawning, so on macOS/Linux PfsaaHost temporarily replaces quoted selected absolute paths with no-space symlink aliases, calls the same AgentCore helper, then removes the aliases. The Renderer never spawns editors or reads AgentCore config files directly.
- Initializing AgentCore's own proxy-aware HTTP dispatcher before reporting `runtime.status=connected`, so OAuth token exchange, model requests, and Provider HTTP calls share the same PfsaaHost route. Package-manager subprocesses such as npm, pnpm, and git retain their own proxy configuration.
- Converting cross-process data into JSON-serializable responses (`jsonSafe`) and keeping stable IDs plus queued image attachments in a PfsaaHost sidecar so queue thumbnails, `promoteQueue`, `editQueue`, and `deleteQueue` can rebuild AgentCore's queue without dropping attachments.
- Scoping every in-memory SessionManager, AgentSession, queue, approval, and lifecycle resource by normalized `cwd` plus AgentCore session ID. Imported JSONL files may preserve the same ID in different projects, but deletion, abort, and queue operations remain project-isolated.
- Running Git workspace inspection and `gh` sharing commands asynchronously with bounded timeouts so external processes do not block the PfsaaHost IPC loop.

Dynamic AgentCore runtime resolution, loading, model/Session adaptation, and guarded loading of AgentCore's version-matched keybinding, settings-storage, and external-editor modules live in `packages/agentcore-adapter`. AgentCore permission configuration, Extension UI binding, approval waiting, and policy switching live in `packages/permission-engine`. Neither creates a second agent, Provider, or Session store; the authoritative sources remain the AgentCore runtime and `@gotgenes/pi-permission-system`. The separate `packages/pfsaa-host/src/cli.ts` is intentionally transparent and calls AgentCore's official `main()` rather than entering the desktop IPC protocol.

Proxy precedence is explicit `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, AgentCore's global `httpProxy` setting, then Electron's cross-platform system-proxy resolution. `agentcore-adapter` first calls AgentCore's version-matched `configureHttpDispatcher()`; only when no explicit/AgentCore proxy exists does it install a thin dispatcher that asks Main to run `session.resolveProxy(url)` for every request URL. PAC, bypass, and domain-specific rules therefore remain URL-aware instead of being flattened into a startup snapshot. Resolution failures reject the request rather than silently falling back to direct traffic. A missing or incompatible dispatcher fails PfsaaHost startup with a sanitized `runtime.error` before process exit.

## 3. Current Repository Structure

```text
PFSAA/
├─ apps/desktop/
│  ├─ index.html                          # Vite Renderer host page
│  ├─ vite.config.mts                     # Renderer ESM build config, outputs to root dist-renderer/
│  ├─ entitlements.mac.plist              # Hardened-runtime entitlements for signed macOS builds
│  ├─ assets/                             # App icons, mac Info.plist, native plugin artifacts
│  ├─ native/miniwindow.mm                # macOS minimized-window icon native customization source
│  ├─ public/                             # Renderer static assets
│  ├─ scripts/
│  │  ├─ build-native.mjs                 # Native plugin build (skipped on non-macOS)
│  │  ├─ behavior-regressions.test.cjs    # Security, concurrency, and packaging behavior regressions
│  │  └─ renderer-regressions.test.cjs    # Renderer behavior and structural guards
│  └─ src/
│     ├─ main/index.ts                    # Electron Main, app menu, and IPC orchestration
│     ├─ main/application-menu.ts         # Native menu template, validated popup and lifecycle
│     ├─ preload/index.ts                 # contextBridge
│     └─ renderer/
│        ├─ App.tsx                       # Entry and Controller/View composition only
│        ├─ main.tsx                      # Renderer mount entry
│        ├─ app-view.tsx                  # Workspace shell and global layout
│        ├─ app-sidebar.tsx               # Project tree, Session list, sidebar interactions
│        ├─ app-conversation.tsx          # Session pane caching, conversation, Composer composition
│        ├─ app-overlays.tsx              # Quick settings, dialogs, global overlays
│        ├─ use-app-controller.tsx        # Page state and action orchestration
│        ├─ use-session-data.ts           # Session/capability/message loading
│        ├─ use-runtime-events.ts         # PfsaaHost runtime event normalization
│        ├─ use-change-review.ts          # Bounded persisted per-Session review/view/detail state
│        ├─ change-review-model.ts        # Pure diff/tree/filter/keyboard projections
│        ├─ use-conversation-scroll.ts    # Session scroll snapshots and latest position
│        ├─ use-stream-deltas.ts          # Bounded batching of streaming deltas
│        ├─ use-global-shortcuts.ts       # Global shortcuts and focus boundaries
│        ├─ use-preferences.ts            # Language and theme preferences
│        ├─ use-notice.ts                 # Lightweight notice state
│        ├─ use-sent-images-cache.ts      # Pending-send image cache
│        ├─ timeline-utils.ts             # Turn grouping, execution summaries, stable timeline items
│        ├─ message-utils.ts              # Message identity, snapshot merging, time formatting
│        ├─ image-cache.ts                # IndexedDB image preview cache via idb
│        ├─ agentcore-capabilities.ts            # Slash command fallback when AgentCore resources are unavailable
│        ├─ palette-command.ts            # Direct command vs editable template activation
│        ├─ types.ts                      # Renderer state and message helper types
│        ├─ styles.css                    # Current UI tokens and layout styles
│        ├─ vite-env.d.ts
│        └─ ui/                           # Presentation components, split by UI responsibility
│           ├─ index.ts                   # Unified UI export
│           ├─ message-timeline.tsx       # Session timeline (document flow + earlier-message folding)
│           ├─ message-view.tsx           # Single-message rendering
│           ├─ execution-summary.tsx      # "Processed" execution summary
│           ├─ live-activity.tsx          # Live thinking and chronological tool-call feed
│           ├─ change-review.tsx          # Split-pane per-run unified diff review
│           ├─ change-review-merge.tsx    # Lazy CodeMirror editable merge dialog
│           ├─ pane-resize-handle.tsx     # Accessible pointer/keyboard pane separator
│           ├─ composer.tsx               # Input, suggestions, queue thumbnails/editing
│           ├─ quick-settings.tsx         # Hierarchical settings, task actions, and searchable AgentCore commands
│           ├─ application-menu.tsx       # Windows title-bar native-menu triggers
│           ├─ dialogs.tsx                # Rename/trust/resume/extension dialogs
│           ├─ approval-card.tsx          # Tool approval card
│           ├─ provider-settings.tsx      # Provider auth settings
│           ├─ package-settings.tsx       # AgentCore package management
│           ├─ permission-level.tsx       # Permission-level control
│           ├─ context-ring.tsx           # Context usage indicator
│           ├─ working-indicator.tsx      # Running indicator
│           ├─ task-row.tsx               # Session row and status markers
│           ├─ skeletons.tsx              # Skeleton screens
│           ├─ markdown.tsx               # Markdown, code blocks, math, Mermaid rendering
│           └─ shared.ts                  # Clipboard and menu keyboard-navigation helpers
├─ packages/
│  ├─ contracts/                          # Bridge/IPC types and Zod runtime payload validation
│  ├─ domain/                             # Task, Project types and shared runtime helpers
│  ├─ agentcore-adapter/                         # AgentCore runtime resolution, loading, model/Session adaptation
│  ├─ pfsaa-host/                            # PfsaaHost process entry and Host command orchestration
│  │  ├─ src/index.ts                     # Host lifecycle, IPC dispatch, and capability orchestration
│  │  ├─ src/host-state.ts                # Process-local Session/Agent/queue/auth registries
│  │  ├─ src/agent-event-adapter.ts       # AgentCore Agent event normalization for the bridge
│  │  └─ src/provider-config-store.ts      # Atomic models.json and credential-free Provider UI-state edits
│  ├─ permission-engine/                  # AgentCore permission config, Extension UI, approval waiting
│  ├─ ui-system/                          # Shared Icon/clipboard primitives and focus-trap adapter
│  └─ i18n/                               # zh/en copy and command descriptions
├─ docs/                                  # Architecture, product plan, AgentCore capability matrix, release guide
├─ rules/                                 # Development and documentation sync rules
├─ .github/workflows/
│  ├─ ci.yml                              # Main/PR verification
│  └─ release.yml                         # Tagged native installers and draft GitHub Release
├─ scripts/verify-package-contents.mjs    # Packaged asar runtime/license/denylist verifier
├─ scripts/smoke-source-runtime.mjs       # Starts built PfsaaHost and exercises a real runtime IPC call
├─ scripts/smoke-session-isolation.mjs    # Verifies same-ID sessions remain isolated across projects
├─ scripts/smoke-packaged-runtime.mjs     # Starts packaged PfsaaHost and verifies the bundled AgentCore runtime
├─ scripts/generate-packaged-sbom.mjs     # Inventories the final asar into a platform-specific CycloneDX SBOM
├─ scripts/generate-third-party-notices.mjs # Deterministic production dependency license inventory
├─ scripts/verify-release-version.mjs     # Release tag/package version guard
├─ dist-renderer/                         # Renderer build output (not committed)
├─ release/                               # electron-builder artifacts (not committed)
├─ electron-builder.config.cjs            # Shared runtime whitelist and platform packaging rules
├─ AGENTS.md
└─ package.json                           # npm workspaces and build/package scripts
```

Each `packages/*` package currently has a single `src/index.ts` entry (`ui-system` uses `src/index.tsx`) with no deeper directory layering. They enforce code-boundary splits without introducing a second agent, permission, session, or credential system.

All Renderer presentation components live in `renderer/ui/`, re-exported through `ui/index.ts`; bounded streaming-delta batching lives in `use-stream-deltas.ts`. The single-file UI components and performance helpers of earlier versions have been replaced by these two structures; historical docs referencing old filenames should be corrected per this section.

## 4. Dependency Direction and Boundaries

```text
renderer → contracts + domain + i18n + ui-system
preload  → contracts
main     → contracts + i18n (menu copy); forks packages/pfsaa-host/dist/index.js by path, never imports its modules
pfsaa-host  → contracts + domain + agentcore-adapter + permission-engine
contracts → zod (strict runtime validation at the PfsaaHost IPC boundary)
agentcore-adapter → AgentCore runtime (dynamic resolution, loading, public API adaptation only)
permission-engine → contracts + @gotgenes/pi-permission-system config
ui-system → React + focus-trap
```

`packages/contracts` provides both TypeScript declarations and executable validation. Its public types point at `src/index.ts`, while PfsaaHost loads the compiled `dist/index.js`; the complete `PfsaaHostCommand` schema map is implemented with strict Zod objects so unknown or coercible IPC values are rejected without maintaining a second handwritten schema language. Workspace typechecks and desktop development/production builds compile in the order `contracts → domain → agentcore-adapter → permission-engine → pfsaa-host → i18n → ui-system`. Vite resolves `@pfsaa/ui-system` and `@pfsaa/i18n` directly to source and excludes them from dependency prebundling, so shared icon/component/label changes hot-reload without a stale `dist` or browser prebundle. Vite still transforms this source into JavaScript for development and production; PfsaaHost loads compiled workspace packages.

Must be observed:

- The Renderer must not import the AgentCore runtime, Node builtins, or credential objects.
- Main must not create `AgentSession` directly.
- PfsaaHost is currently the only code boundary allowed to depend on the AgentCore runtime.
- Cross-process messages carry only JSON/structured-clone serializable data.
- New IPC must update `packages/contracts` first, then Main, Preload, and Renderer.
- AgentCore fallback capabilities must live outside UI components and state that the AgentCore CLI/SDK remains the authoritative source.

Renderer image previews remain a non-authoritative cache. `image-cache.ts` uses the small `idb` Promise wrapper while preserving the existing `pfsaa-cache` database, `snapshots` object store, structured-clone values, and `localStorage` fallback. Shared modal focus behavior is implemented once in `ui-system` over `focus-trap`; PFSAA retains its own dialog markup and inert application-shell boundary, while the library owns nested trap stacking, dynamic tabbable discovery, Escape routing, and focus restoration.

Searchable action selection uses `cmdk` for the AgentCore commands subpage in Quick settings and the Composer model chooser, so filtering, active-option semantics, arrow-key navigation, scrolling, and Enter activation share one tested interaction primitive. PFSAA still owns AgentCore command routing and model selection side effects. Plain filters that do not select an action use native Chromium search inputs, and transcript search remains Session-data-aware because browser page search cannot see folded, unmounted history.

PfsaaHost restores the desktop transcript by projecting every entry on AgentCore's complete active `SessionManager.getBranch()`. It deliberately does not expose `AgentSession.messages` as history because that array is the compaction-aware model context and omits the summarized prefix after a restart. Context compaction therefore remains effective for subsequent model requests without hiding persisted pre-compaction turns from the user.

The Renderer session timeline is composed of `app-conversation.tsx` and `ui/message-timeline.tsx` as a **plain document-flow list with earlier-message folding** — no virtual list. Consecutive Assistant commentary records inside one turn retain unique React identities and use a shared three-level rhythm for turn, continuation, and section spacing through the transition into live Activity, while the final record alone reuses the live response key. During a run, the execution summary is a non-interactive elapsed-time indicator while `ui/live-activity.tsx` renders normalized thinking blocks and tool calls in their actual chronological order as a low-emphasis inline flow rather than a separate raised card. After settlement, the live panel retracts and the complete process moves into the expandable summary. Both live and completed process regions have the same bounded viewport-relative height and scroll internally on overflow; while the live region is following, `ActivityStep` refreshes and late Markdown/diagram resizes keep its inner viewport pinned to the newest output, an intentional upward wheel/touch gesture pauses that follow, and returning to the inner bottom resumes it. These process regions are marked as nested scroll islands, so their wheel/touch/captured-scroll events never change the outer transcript follow state or show its "jump to latest" control. Tool arguments/results stay collapsed per call, and excessive provider blank lines are compacted for presentation only. Because Mermaid, KaTeX, and syntax highlighting are asynchronously sized, the measure-position loop of virtual lists is fundamentally incompatible with them (jumping, overlap, rubber-banding); instead only the most recent `FOLD_WINDOW = 200` messages stay mounted, with older messages folded behind a "show earlier" button revealing `FOLD_STEP = 200` at a time. Anti-jump relies on native scroll anchoring: `.conversation-scroll` must keep `overflow-anchor: auto` (the virtual-list-era `none` disables that mechanism).

Per-run change review is owned by PfsaaHost plus `session-change-review.ts` and `session-change-review-store.ts`. At `agent_start`, PfsaaHost captures the current Git worktree baseline without changing the user's index; a non-Steering Follow-up closes the previous segment and reuses the same boundary inspection as the next baseline, while Steering remains in the active segment. Known mutating tool completions (edit, write, Bash, and PowerShell) schedule one debounced, supersedable preview; settlement performs the authoritative comparison, including workspace changes made by other processes during the same interval. Candidate paths, retained baseline bytes, per-file/total patches, generated files, and Git duration are hard-capped. Rename, executable-mode, binary, oversized, committed-HEAD, and truncated states are represented explicitly.

Completed reviews no longer append full patches indefinitely to Session JSONL. PfsaaHost writes one small versioned `pfsaa.change-review-store` custom-entry anchor and atomically replaces a sidecar beside the AgentCore Session file. The sidecar retains at most 20 reviews and 12 MB, is copied beside JSONL exports/imports, and is removed with the Session. The latest valid legacy `pfsaa.change-review` records are copied into the sidecar on the next write; their original append-only JSONL entries remain untouched for compatibility, but no new full-patch entries are appended. Every legacy/imported/sidecar record is schema-, path-, count-, and byte-validated; invalid sidecars are quarantined. `sessions.changeReviews` returns summary-only records plus Git availability, while `sessions.changeReview` lazily returns the selected bounded patch detail, preventing a 20-run patch snapshot from crossing IPC on every Session switch. PfsaaHost tracks final write promises, serializes sidecar mutations, and the graceful `runtime.shutdown` handshake waits briefly before Main terminates the Host.

`ui/change-review.tsx` opens from the Composer summary as a wide split pane or focus-trapped overlay drawer whose title bar, project sidebar, dividers, and covered conversation are inert. It provides the rounded run picker, filtered/aggregated directory tree with full arrow-key navigation, unified or Codex-style split diff, line wrapping, whitespace-only filtering, lightweight syntax highlighting, hunk navigation and resolution, incremental row folding, path copy, precise file/global truncation messages, and actionable non-Git/Git/storage/detail-load retry states. Complete UTF-8 text patches expose per-hunk accept/revert; revert requires confirmation and applies only an exact zero-fuzz reverse patch. `change-review-merge.tsx` lazily loads CodeMirror's unified merge view for per-chunk controls and arbitrary final edits. PfsaaHost reconstructs the unresolved baseline, confines regular files to the project, serializes mutations, writes atomically, and rejects a save if the file revision changed after the editor opened. Resolution metadata is persisted in the bounded review sidecar. Review open/run/file/tree/split/options/scroll state is bounded and persisted per Session by `use-change-review.ts`; patches remain Host-owned. A newly queued empty Follow-up cannot hide the newest non-empty summary. The UI labels the result as interval worktree changes because concurrent external edits cannot be attributed exclusively to AgentCore. Staging and commit orchestration remain outside this mapping; binary, oversized, or truncated patches stay read-only.

Each visited Session keeps its own pane; inactive panes use `visibility: hidden` instead of `display: none`, so the browser naturally preserves each pane's `scrollTop` without manual restore logic, while their scroll/resize/mutation observers are disconnected until the pane is active again. The `ConversationScrollSnapshot` is only `{ top, follow }`. Leaving follow is driven **only by real input gestures** (`wheel` with `deltaY < 0`, or an upward touch drag) — never by inferring direction from a shrinking `scrollTop`, because content legitimately shrinks (a live row replaced by the final message, the working indicator disappearing, an execution summary collapsing) and a delta-based guess misreads that as "user scrolled up", killing auto-follow mid-stream. During programmatic smooth scrolling, `pinningRef` (with a 1000ms timeout safety valve) latches follow so the "jump to latest" button does not flash back mid-animation. Modal overlays mark the application shell inert/hidden from assistive technology, and the shared focus primitive lets only the topmost nested dialog handle Escape.

PFSAA's Renderer `activity`/`completedActivity` remains presentation state of the current process and is never written back into the Session. To restore "processed" durations reliably, PfsaaHost records each execution group's `startedAt/endedAt/durationMs` at `agent_start`, non-Steering Follow-up boundaries, and `agent_settled`, writing them as a `pfsaa.execution-run` custom entry via AgentCore's official `SessionManager.appendCustomEntry()`; the entry never enters the LLM context. The Renderer reads exact durations through `sessions.runMetadata`; AgentCore's raw thinking/tool content is used only to rebuild step content. Old sessions without this metadata show "processed" but never infer durations from message timestamps.

### Desktop parity adapters

`agentcore-command-arguments.ts` resolves exact runtime model IDs and export filenames. `sessions.export` accepts an optional output path: Main validates it, resolves project-relative/`~/` paths, and obtains native save/overwrite confirmation before PfsaaHost calls AgentCore's exporter. A cancelled picker returns `null`. `.jsonl` paths select JSONL, and other paths select HTML.

`settings-command-handler.ts` reads AgentCore's effective non-TUI settings through AgentCore's getters and writes only changed retry/compaction/branch-summary (including `skipPrompt`)/network/image/trust/shell/session/resource/telemetry keys through `FileSettingsStorage.withLock`, preserving nested provider retry policy and unknown settings. Existing proxy credentials are stripped from the summary and preserved unless explicitly replaced. The session-tree overlay reads the effective `skipPrompt` value and hides its summary control when AgentCore's no-summary path is configured. Network, shell, and session-directory changes apply after a Host/application restart; default tools apply to newly created sessions.

`extensions.syncEditor` / `extensions.invokeShortcut` map to `extension.editor.sync` / `extension.shortcut.invoke`. Both validate project scope and bounded text. The former updates a project/session-scoped presentation mirror without creating an Agent; the latter re-resolves AgentCore `ExtensionRunner.getShortcuts()` against effective keybindings, flushes the supplied draft, and calls the real handler with `createContext()`. `SessionCapabilities.extensionShortcuts` contains only key/description DTOs. `use-extension-editor.ts` blocks dispatch during IME composition, repeated keydown, concurrent handlers, and modal dialogs. Live text is an asynchronous desktop mirror, not a synchronous cross-process TUI component.

`extension-theme.ts` in PfsaaHost retains actual SDK Theme objects and resource-loaded themes. AgentCore's version-matched theme companion module is capability-guarded by `agentcore-adapter`. A stable proxy preserves `ui.theme` after SDK context copying. Theme events are `extension.ui.presentation` with `action: "theme"` and an `ExtensionThemeSnapshot`: only hex colors and a light/dark appearance cross IPC. Renderer validates a fixed token allowlist and applies it to the active Session's shell and overlays. Interactive `custom` factories are adapted into bounded terminal-style lines and key input; component instances are never serialized.

Manual compaction Stop renders from `isSending || isCompacting`, calls `abortCompaction()` before `abort()`, and transfers staged messages back to native AgentCore queues without starting them after cancellation/failure. Their IDs, order, text, and images are preserved. Manual compaction and interactive Extension shortcuts are event-driven requests without the default 60-second timeout; process disconnect still rejects pending requests.

The Session Tree uses fixed-width branch rails rather than increasing indentation for each message. Host projection is iterative and capped at 5,000 entries with an explicit truncation notice; Renderer pages contain at most 160 rows. Skill invocations show the skill name and user request instead of expanding the embedded instructions. Info/warning notices remain for eight seconds, errors remain until dismissed, and every notice has a close button. Permission configuration repairs only a trailing literal `\n` after otherwise valid JSON; other parse/write failures do not overwrite the file or change the in-memory mode. Missing bash fallbacks are made explicit while existing command-specific rules and explicit fallbacks are preserved.

After a Host restart, a session operation resolves its persisted ID through AgentCore `SessionManager.list(cwd)` if the path cache is cold. Unknown IDs fail explicitly instead of silently creating an empty session. Runtime smoke exercises this before any session-list request.

## 5. Current Bridge Capabilities

Per `PfsaaBridge` in `packages/contracts/src/index.ts`, currently declared:

- `app.setLanguage/setWindowTheme/quit`
- `runtime.status`
- `projects.list/chooseDirectory/remove/trustStatus/setTrust`
- `sessions.list/create/delete/remove/messages/runMetadata/changeReviews/changeReview/capabilities/compact/export/import/rename/generateTitle/stats/share/changelog`
- `models.list/refresh`
- `workspace.snapshot`
- `input.keybindings/externalEdit`
- `providers.list/listHidden/discoverModels/create/update/remove/restore/login/cancelLogin/logout/setApiKey/resolveAuth/openAuthUrl`
- `agent.prompt/executeBash/abort/setThinkingLevel/setModel/cycleModel/setScopedModels/queue/setQueueModes/clearQueue/promoteQueue/editQueue/deleteQueue`
- `sessions.compact/reload`, `settings.get/update/chooseExternalEditor`, `extensions.resolveUi/syncEditor/invokeShortcut`
- `packages.list/install/remove/update/configure/configureResource/checkUpdates`
- `approvals.resolve`
- `permissions.status/setMode`

Every invoke handler validates that the caller is the active PFSAA window's main frame. Project-scoped calls accept only directories already recorded in Electron's project registry; new directories enter that registry only through the native directory picker. Session import likewise always obtains its JSONL path from Electron's native file picker—the Renderer cannot provide an arbitrary filesystem path.
- `events.subscribe`

`providers.list` reports a sanitized authentication source, stored-credential
availability, deletion ownership, and whether an OpenAI-compatible local
`models.json` entry is editable. Only editable entries include a base URL and
model IDs/names, never credentials or other model metadata. `providers.discoverModels`
performs an explicit, bounded GET to the user-configured OpenAI-compatible
`/models` endpoint in PfsaaHost; it does not mutate configuration. `providers.create`
adds one Provider with the selected static model definitions, while
`providers.update` modifies only editable local definitions and preserves existing
per-model metadata for retained IDs. Both validate through the real
`ModelRuntime` without model-catalog network refresh, and creation persists its
key through AgentCore. `providers.remove`
truly removes only a PFSAA-owned definition; it removes a stored credential
before hiding an external/runtime definition from this authentication page.
When a loaded Session has selected a Provider, `providers.update` may add models
while keeping its service URL and selected model IDs. Changing that URL or
removing a selected model still requires switching the affected Sessions first.
`providers.listHidden` and `providers.restore` provide an explicit recovery
path. Environment, model-file, and runtime-provided authentication remain
managed by their external source. A failure stays inside its confirmation
dialog with a retry path.

Three naming relationships need attention:

- `sessions.remove` is an alias of `sessions.delete`; both go through the same `sessions:delete` IPC channel.
- `providers.resolveAuth` / `providers.cancelLogin` / `providers.openAuthUrl` correspond to IPC channels `providers:auth-response` / `providers:cancel-login` / `providers:open-auth-url`; the first two are forwarded to PfsaaHost commands `providers.auth-response` / `providers.cancelLogin`, while the last is opened by Main directly in the system browser.
- `sessions.changelog` maps to the PfsaaHost command `app.changelog`; `projects.list/chooseDirectory/remove` are composed by Main from `projects.json` plus the PfsaaHost `projects.list` and `sessions.list` commands, with no one-to-one Host command. `projects.trustStatus/setTrust` map to PfsaaHost's AgentCore `ProjectTrustStore`; PfsaaHost derives the effective saved, inherited, or default decision and passes it to every project `SettingsManager` and `ResourceLoader` construction.

If the docs disagree with `packages/contracts`, contracts and the implementation win; the docs must be updated in the same change.

## 6. Current Event Flow

`PfsaaRuntimeEvent` declares the types `runtime.status`, `runtime.error`, `agent.event`, `auth.event`, `approval.requested`, `approval.resolved`, `extension.ui.request`, `extension.ui.notify`.

Six message shapes are currently dispatched with a top-level `type`:

```ts
{ type: "runtime.status", payload: "connected" | "starting" | "disconnected" }
{ type: "runtime.error", payload: { message: string } }
{ type: "agent.event", taskId, event }
{ type: "approval.requested", taskId, requestId, event: { toolName, args } }
{ type: "auth.event", requestId, event }
{ type: "extension.ui.request", taskId, requestId, event: ExtensionUiRequest }
```

`approval.resolved` and `extension.ui.notify` are emitted by `packages/permission-engine` through PfsaaHost's `emit()`, so when they reach the Renderer they are wrapped in `agent.event` under `event.type` rather than at the top level. `approval.resolved` is only produced when switching permission modes auto-approves or denies a pending approval; the approval card is then cleared locally by the Renderer after `permissions.setMode` succeeds. The `approval.resolved` branch matched by top-level `type` in `use-runtime-events.ts` currently never hits; making top-level events work requires posting directly from PfsaaHost and updating this section in the same change.

`runtime.status` is published by Main: `connected` when PfsaaHost reports it, `starting` during process startup, `disconnected` at process exit with all pending requests rejected.

Auth prompts come back through `providers.resolveAuth` (IPC `providers:auth-response`) as text, options, or a cancel state; cancelling ends AgentCore's wait without leaving a pending login request, and PfsaaHost also propagates AgentCore's per-prompt abort signal so SDK-cancelled fallback prompts do not leave stale waiters. Each Renderer OAuth attempt carries an opaque operation ID. Closing Provider settings calls `providers.cancelLogin`, and PfsaaHost aborts that operation through AgentCore's `AuthInteraction.signal`; starting another attempt for the same Provider also supersedes any stale operation before invoking `ModelRuntime.login()`. For the version-guarded AgentCore 0.84.2–0.85.1 OpenAI Codex browser flow, PfsaaHost probes the SDK's fixed loopback listener endpoint before resolving the browser-method prompt. A failed probe keeps that prompt active so the Renderer can show an actionable error and the user can choose AgentCore's device-code method. The SDK's concurrent manual-code prompt stays a secondary fallback while the loopback callback is pending, and Main restores/focuses the PFSAA window after `providers.login` succeeds.

`agent.event` currently covers agent start/end, agent settled, turn start/end, message start/update/end/snapshot, tool execution start/update/end, queue update, and AgentCore `ui_prompt_start` / `ui_prompt_end` events. Extension UI requests are explicitly normalized into serializable `{ type, reason, kind, title?, lines? }` payloads; standard dialogs use `extension.ui.resolve`, while AgentCore's custom component UI uses `extension.ui.input` to forward terminal-style key sequences. Persistent component Widgets, Footer/Header, and editor components render inside PfsaaHost at a fixed width with bounded output and coalesced refreshes. `extension.input.dispatch` preserves terminal-input consume/rewrite chaining, while `extension.autocomplete` runs providers with timeout/cancellation and returns only bounded, applied text/cursor candidates. Queue updates are normalized into stable-ID entries with text and serializable image payloads; clear-and-rebuild mutations suppress intermediate empty/partial updates and publish one authoritative result. The `messages` of `agent_end` come from the AgentCore runtime, so the Renderer can merge the round's messages before any automatic retry or queue continuation; `agent_settled` then reads the final Session snapshot. The Renderer only consumes serializable normalized objects, never `AgentSession` instances.

## 7. AgentCore Capability Mapping

- AgentCore Session / `cwd` → left project tree, per-project session lists, and the central conversation.
- AgentCore ModelRuntime → Provider settings, model selection, and thinking level.
- AgentCore slash command / Prompt / Skill catalog → Composer suggestions and the searchable AgentCore commands subpage in Quick settings.
- AgentCore Agent event → streaming replies, tool process, approvals, and run status.
- AgentCore Session export/compact → session operations in Quick settings; Session Tree `/fork`, `/clone`, and `/tree` → one focus-trapped branch browser. PfsaaHost projects `SessionManager.getTree()` into bounded serializable summaries, marks the current active path, and validates every selected entry. Fork uses `AgentSessionRuntime.fork()` and returns AgentCore's selected user text to the Composer; clone forks the current leaf at-position; tree navigation stays in the same Session and can optionally call AgentCore's abortable branch summarizer. Session replacement events move Renderer state to the new AgentCore Session identity before its timeline is loaded.
- AgentCore Agent steering/follow-up queue → compact Composer-attached queue stack, delivery mode, batch mode, images, promotion, editing, and deletion. Automatic compaction routes input through AgentCore's native queues; manual compaction uses a scoped Host staging queue because it ends without an active Agent run, then starts the first staged prompt and transfers the rest back to AgentCore in order. The same stable-ID mutation surface covers both queues, and preflight reservations prevent competing direct prompts.
- AgentCore package management → AgentCore packages settings panel in Quick settings.
- The header gear / `Ctrl/Cmd + ,` opens the compact Quick settings root; task actions and AgentCore commands are drill-down pages, while `Ctrl/Cmd + K` opens the AgentCore commands page directly. The former header Provider and standalone command launchers are removed. All settings drawers are anchored below `--titlebar-height` on macOS and Windows.
- The AgentCore commands subpage dispatches click/Enter through `palette-command.ts`: built-ins call existing desktop handlers, runtime-tagged `source: "extension"` commands call AgentCore's prompt bridge, and Prompt/Skill resources remain editable templates. Fixed actions filter their equivalent slash commands to avoid duplicate rows. The optional source metadata is additive to `SessionCapabilities`; no new IPC endpoint is introduced. Dialog focus restoration uses a shared workspace-origin context when the launcher has already unmounted.
- AgentCore permission system modes → permission-level control below the input.
- AgentCore workspace file list → `@file` reference candidates in the Composer. `workspace.snapshot` also returns git `changes`, but the current UI has no standalone Files/Changes panel, so the field is not yet consumed.

Capabilities without a stable Bridge or UI must be shown as unimplemented, never faked as successful. PFSAA does not maintain a separate AgentCore CLI execution panel.

## 8. Packaging and Distribution

Local packaging keeps the current-host `package:mac` command and exposes explicit `package:mac:arm64`, `package:mac:x64`, and `package:win:x64` commands for matching native runners. Installer filenames include the operating system and architecture; package verification checks the asar runtime entries, PFSAA notices, Electron/Chromium runtime licenses, and denylist after each build. Native packaging jobs then start PfsaaHost from the packaged `app.asar`, call `runtime.status`, and verify through `app.info` that the bundled AgentCore runtime matches the locked version.

`.github/workflows/release.yml` starts on a matching version tag (or a manual rebuild of an existing tag), requires the tag commit to be contained in `main`, pins that commit SHA, rejects tags that differ from `package.json`, reruns dependency-notice/lint/typecheck/test/build checks, and packages Windows x64, macOS arm64, and macOS x64 separately. Each native job inventories its final `app.asar` into a platform-specific CycloneDX SBOM. The final job generates `SHA256SUMS.txt`, creates GitHub provenance attestations, and creates or updates a draft GitHub Release.

The native packaging jobs run through the protected `release-signing` Environment and expose certificate material only to their `electron-builder` step. macOS hardened runtime, entitlements, and notarization are enabled when the corresponding signing and Apple API secrets are present; Windows Authenticode uses its own certificate secrets. Without trusted certificates the workflow remains useful for test installers, but those artifacts are not suitable as trusted public releases.

## 9. Runtime Verification

For desktop parity, additionally verify advanced settings round-trip/validation and unchanged proxy credentials; `/model provider/model` including late Extension registration; native-confirmed HTML/JSONL export paths with spaces and picker cancellation; manual compaction Stop with staged text/images and no automatic continuation; registered shortcut conflict/modal/IME handling; scoped editor text; AgentCore theme lookup/selection and Session isolation; actionable TUI compatibility notices. UI checks use an isolated agent directory and Electron profile, with no external model prompts.

For Windows menu changes, verify `app:popup-menu` through the Preload bridge: all three groups and the compact menu, pointer/keyboard dismissal, copy/paste with an existing text selection, zoom-adjusted anchors, localization, packaged-only restrictions, and rejection of unknown groups or malformed coordinates. Check 375/560/760/1024/1440px layouts and caption-button clearance; macOS must not render duplicate title-bar menus. These desktop menus do not call PfsaaHost.

After changing PfsaaHost, contracts, Main, Preload, or Provider/Session-related capabilities, at minimum execute:

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
sessions.changeReviews
sessions.changeReview (missing ID returns null)
sessions.capabilities
  # Verify registered Extension commands carry source: "extension".
agent.cycleModel
agent.queue
agent.deleteQueue (missing stable ID must fail without mutation)
workspace.snapshot
```

And run:

```bash
npm run lint
npm run typecheck
npm run test:renderer
npm run build
```

`npm run test:renderer` first runs `prebuild` to compile all workspace packages, then runs the structural renderer guards and behavior-level security/concurrency regressions in `apps/desktop/scripts/*.test.cjs` with `node --test`.
