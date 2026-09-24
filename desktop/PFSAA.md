# PFSAA Desktop Integration Contract

This directory contains the PFSAA desktop product layer. It adapts an
open-source Electron desktop architecture to this project's existing AgentCore
runtime; it does not create a second Agent implementation. PFSAA owns the
desktop-facing identity, while AgentCore remains the core identity for Agent,
session, model, tool, and resource behavior. This is a controlled project
integration, not a standalone PFSAA installer release.

## Development handoff

Linux is the development environment, not the delivery target. A product
release synchronizes the related `source/`, `desktop/`, documentation, and
lockfiles to the Windows project as one version. Exclude
`runtime/`, `node_modules/`, generated build output, and packaging output.
Check for Windows-side edits, create a recoverable backup, verify transferred
contents, and run the Windows build and real AgentCore runtime smoke test
before calling it delivered.

## Runtime contract

- Main locates the PFSAA project root one level above `desktop/`, or takes an
  explicit `PFSAA_PROJECT_ROOT` when developing from another location.
  `PFCA_PROJECT_ROOT` remains a read-only compatibility alias. It
  requires the Windows-built `source/packages/agentcore-cli/dist/index.js`.
- Main creates the local `runtime/` directory when needed, forks PfsaaHost with
  `cwd=runtime/`, points the runtime at AgentCore's built module, and applies
  fixed `AGENTCORE_*` paths and offline/telemetry settings. On Windows it also preserves `WSLENV` entries while mapping
  the runtime paths and available `PFSAA_PYTHON` into WSL, so a legacy `bash.exe`
  tool executes against the same product workspace. It does **not** execute the CLI launcher: PFSAA's existing
  Renderer -> Main -> PfsaaHost -> SDK stream remains intact.
- PfsaaHost creates, lists and opens sessions in the one flat directory
  `runtime/.agent/sessions`. It disables automatic Extension, Skill, Prompt
  and context discovery, then loads the Credential Guard and any available
  project Skills. Project-specific Skills are not included in this public
  snapshot; without locally supplied Skills, the desktop starts but does not
  provide specialized power-flow adjustment behavior. The SDK remains
  responsible for models, credentials, tools, events and session persistence.
- A single runtime workspace is enforced in Main and PfsaaHost. Workspace file
  snapshots and Git change reviews do not scan `runtime/`. Multi-project
  management, session import/share, file review and package management are not
  supported in this version. The Host rejects unsupported requests even if an
  upstream AgentCore command remains visible in the interface.
  `sessions.capabilities` returns `changeReviewEnabled: false` in this mode, so
  the Renderer neither requests review data nor renders an unavailable review
  launcher or drawer.

## Windows validation

On the Windows project copy, build AgentCore through its existing Windows
verification process; do not build or test `source/` on Linux. Regenerate the
two lockfiles with npm after package-name changes, install the locked desktop
dependencies locally, then run `npm run test:pfsaa`, `npm run test:renderer`,
and `npm run build` in `desktop/`. Then set
`PFSAA_SOURCE_DIR` to the Windows project's `source/` directory for
`npm run smoke:pfsaa`; the smoke test links that source into a disposable
project with an empty runtime and does not contact a Provider. Start the application
with `npm run dev` from `desktop/` and verify with an isolated, non-production
runtime before opening the existing private runtime. Do not issue a real model
prompt without authorization.

Electron 43's npm package can leave the binary absent after `npm ci`; if
`node_modules/electron/dist/electron.exe` is missing, run
`node node_modules/electron/install.js` locally before launching. A newly
created empty session is not persisted by the SDK until it has an entry; use
an offline session with a persisted message when testing restart recovery.

Before calling this integration usable, verify Windows Electron can create,
list and reopen the *same* PFSAA sessions, that the Guard and any locally
supplied Skills load without diagnostics, and that streaming, abort and
extension UI requests work. Also verify the desktop starts when no project
Skills are installed. Previous isolated results do not replace validation after
a product rename. `package:win` may verify package contents and runtime diagnostics, but
it does not establish a standalone installation while the product requires an
adjacent AgentCore runtime. The public snapshot does not include project root
launch wrappers or private Skill files.
