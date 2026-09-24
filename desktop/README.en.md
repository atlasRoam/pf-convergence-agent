# Power-Flow Solving and Adjustment Agent (PFSAA)

PFSAA is the desktop product layer for power-flow solving and adjustment. It
uses the existing Renderer -> Preload -> Electron Main -> PfsaaHost ->
AgentCore runtime path for sessions, streaming messages, tool results,
approvals, and extension interaction. It does not implement a second Agent,
model, credential, or session system.

[中文](README.md)

## Product and Core Boundary

- **PFSAA** owns the product name, desktop application, `PfsaaHost`, first-party
  `@pfsaa/*` packages, and new desktop preferences and runtime configuration.
- **AgentCore** owns the Agent, CLI, sessions, models, tools, and resource
  loading in `source/`; it is the only core implementation.
- **Upstream compatibility** retains `@earendil-works/pi-coding-agent`, legacy
  `PIDECK_*`/`PFCA_*` environment variables, and prior desktop preference keys
  only to read existing dependencies or state. New writes use PFSAA names.

The fixed workspace uses this project's `source/` and `runtime/`. AgentCore
continues to persist sessions in `runtime/.agent/sessions/`; the desktop only
migrates its preferences, image cache, and change-review metadata and never
copies, merges, or rewrites the existing session store.

Providers added from authentication settings still use AgentCore's
`runtime/.agent/models.json` and credential storage. The desktop only writes a
controlled OpenAI Chat Completions-compatible definition, then records its
ownership and authentication-page visibility in the credential-free
`runtime/.agent/pfsaa-provider-ui.json`. PFSAA-created Providers can therefore
be truly removed; built-in, Extension, and externally configured Providers can
only be hidden from and restored to this page, never rewritten at their source.

PFSAA-created Providers can be edited later and can contain multiple models.
Model IDs may be entered manually or fetched on explicit request from the
OpenAI-compatible `/models` endpoint through PfsaaHost. Discovered results are
only saved after the user selects them; manual entry remains available when
discovery fails.

## Current Scope

The first release supports session and task interaction for one fixed PFSAA
workspace. The Renderer has no direct access to Node, the private runtime, the
SDK, or credentials. Every cross-process value passes through a typed Preload
bridge and Host validation. Unsupported upstream capabilities must be rejected
by the Host with an actionable UI error, not merely hidden behind a button.

Power-flow work remains the responsibility of loaded AgentCore Skills and the
existing PFNT tools. The desktop never edits an original DAT file, guesses an
engine, or presents numerical convergence as an engineering conclusion.

The public repository excludes project-specific Skills, PFNT engines, and case
data. The desktop can still start without those private resources, but specialized
power-flow adjustment requires users to provide their own Skills, engine, and tools.

## Development and Verification

Linux is the source development environment; Windows is the build and delivery
verification environment. Each product change synchronizes `source/`,
`desktop/`, related documentation, and lockfiles as one version
to Windows, while excluding `runtime/`, `node_modules/`, build output, and
packaging output. Back up the existing Windows copy before transfer and verify
hashes afterward.

On Windows, complete the following in order:

1. Regenerate and verify `source/package-lock.json` and `desktop/package-lock.json` with npm.
2. Build AgentCore, then run desktop type checking, renderer tests, Host smoke tests, and the production build.
3. Validate the window, IPC, persisted-session recovery, and Skill loading with an isolated runtime. A real Provider or real case requires separate authorization.

See the [PFSAA integration contract](PFSAA.md),
[architecture](docs/architecture.en.md), and
[AgentCore feature matrix](docs/agentcore-feature-matrix.en.md) for the current
implementation and limits.

## Run From Source

Node.js `>=22.19.0` is required. In the Windows project copy, install the
locked dependencies in `desktop/`, then run:

```powershell
npm run dev
```

The desktop development launch requires the built AgentCore runtime in the
same project and creates the local `runtime/` directory as needed. This public
snapshot does not include project launch wrappers or private project Skills.
To use the CLI, configure your own resources according to the
[AgentCore CLI documentation](../source/packages/agentcore-cli/docs/index.md).
The desktop connects to the Host directly rather than creating a parallel CLI
session channel.

## Release Boundary

This version is a controlled integration with an adjacent project runtime. It
is not yet declared a standalone installer that can run outside the project
directory. Packaging, signing, runtime bundling, and upgrade policy require a
separate decision after Windows verification passes.
