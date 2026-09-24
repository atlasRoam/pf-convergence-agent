# PFSAA Development Guide

PFSAA's only product boundary is mapping the existing capabilities of `@earendil-works/pi-coding-agent` (AgentCore CLI) onto a desktop UI.

Do not add product capabilities that AgentCore CLI does not have, nor a second Agent implementation. Every UI capability must trace back to a real API, event, or resource of AgentCore CLI / AgentCore runtime.

## Required Reading Before Development

- [AgentCore CLI scope and adaptation principles](rules/agentcore-runtime-scope.md)
- [Dependency upgrades and runtime compatibility](rules/dependency-management.md)
- [Electron/PfsaaHost communication and validation](rules/runtime-compatibility.md)
- [Documentation sync rules](rules/documentation-management.md)
- [UI/UX development standards](rules/ui-ux-standards.md)
- [Renderer session timeline and scrolling rules](rules/renderer-session-timeline.md)
- [PFSAA product and technical plan](docs/product-plan.en.md)
- [PFSAA current architecture](docs/architecture.en.md)
- [AgentCore CLI → PFSAA feature matrix](docs/agentcore-feature-matrix.en.md)

## Runtime Environment

- Node.js: `>=22.19.0`, matching the current AgentCore runtime engines requirement.
- Electron: use the current stable release. PfsaaHost is forked from Electron's bundled Node via `ELECTRON_RUN_AS_NODE` and reads the asar archive. The bundled Node must satisfy the AgentCore runtime engines; otherwise switch to an external system Node and unpack node_modules entirely (a system Node cannot read asar).
- AgentCore runtime path resolution prefers `PFSAA_RUNTIME_MODULE`; on dev machines it can be located via the global `pi` / npm root.
- After changing dependencies, update `package-lock.json` and run `npm run typecheck` and `npm run build`.
- Local packaging uses `npm run package:win` (NSIS installer) and `npm run package:mac` (DMG). Both are unsigned; signing, notarization, or an installer release pipeline is required before official distribution.

## Code Boundaries

- The Renderer accesses AgentCore capabilities only through the Preload bridge; it must not import the AgentCore runtime, Node built-ins, or credential objects directly.
- All visible copy lives in the i18n config/module; components read keys only and must not accumulate zh/en string literals in JSX.
- Fallback catalogs for AgentCore capabilities must live outside UI components and clearly state that AgentCore CLI/SDK remains the authoritative source.
- Main handles only windows, IPC orchestration, and Host lifecycle.
- `apps/desktop/src/renderer/App.tsx` keeps only the entry and composition; pages, controllers, session timeline, scrolling, and runtime event logic belong in the corresponding `app-*`, `use-*`, `timeline-*`, or UI modules.
- PfsaaHost owns Session, ModelRuntime, Agent, Tool, Provider, resources, and CLI compatibility capabilities.
- Cross-process messages must be JSON/structured-clone serializable data; never pass functions, class instances, or AbortController.
- New IPC must update `packages/contracts` first, then be implemented in Main, Preload, and Renderer.

## Definition of Done

Every fix must verify all of the following:

1. PfsaaHost starts and reports runtime status.
2. At least one real IPC smoke call succeeds.
3. TypeScript check and production build pass.
4. On failure the UI shows an actionable error, not infinite loading or silent blankness.
