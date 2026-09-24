# AgentCore CLI Capability Scope

## Principles

PFSAA is only a desktop adaptation layer for AgentCore CLI. Feature names, arguments, states, and error semantics must follow the currently installed AgentCore CLI/SDK.

Prefer reusing:

- `ModelRuntime`
- `AgentSession`
- `SessionManager`
- `ResourceLoader`
- AgentCore built-in slash commands
- AgentCore Agent event stream
- AgentCore Provider/auth storage
- AgentCore built-in tools and session export

Do not duplicate a "similar-looking" Agent, model catalog, auth store, or session database inside the adaptation layer.

## UI Mapping Rules

- AgentCore slash command -> Composer suggestion / searchable AgentCore commands subpage in Quick settings.
- AgentCore `@file` / resource -> workspace resource suggestion.
- AgentCore model/provider/auth -> PFSAA model/provider UI.
- AgentCore agent event -> conversation stream / tool result / approval state.
- AgentCore session file/tree/export -> session list / session operations.
- Do not fake support for capabilities AgentCore CLI lacks; hide them or mark them as not implemented.

## Maintainability

- AgentCore command, model, and resource catalogs must be read from the runtime first; fallbacks live outside UI components per the AGENTS.md Code Boundaries.
- Visible copy follows the AGENTS.md Code Boundaries; add a stable i18n key first, then fill in each language config.

## Compatibility

When upgrading the AgentCore runtime, read its type declarations and changelog before modifying the adapter. Do not rely on undocumented internal properties unless you also provide version-compatibility guards and clear errors.
