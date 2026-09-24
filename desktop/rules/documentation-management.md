# Documentation Sync Rules

## Purpose

PFSAA documentation must reflect the current code and the capabilities of the currently installed AgentCore runtime. Do not present product plans, target architecture, or example code as implemented features.

## Mandatory Constraints

1. When the project structure changes, update the affected documents in the same change:
   - `README.md`: entry points, how to run, project positioning.
   - `docs/architecture.en.md`: process boundaries, directory structure, dependency direction, runtime topology.
   - `docs/agentcore-feature-matrix.en.md`: the actual mapping from AgentCore capabilities to UI/Quick settings/compatibility channels.
   - `docs/product-plan.en.md`: the current implementation baseline and unimplemented plans.
   - English docs are the primary reference; keep the `docs/*.zh-CN.md` versions in sync.
2. When a `packages/contracts` IPC command, event, DTO, or field changes, update the architecture doc, the feature matrix, and the corresponding runtime validation checklist.
3. When adding or removing UI capabilities, AgentCore runtime capabilities, Extensions, Providers, permission mechanisms, or CLI command mappings, update the feature matrix; unimplemented capabilities must be marked "not implemented".
4. Directories, package names, APIs, SDK versions, the Electron communication model, and command lists in documentation must follow the current code or the currently installed AgentCore runtime. Content that cannot be verified belongs only in "planned/target" sections.
5. When a third-party AgentCore Extension is added, removed, or replaced, record: package name, version, loading method, config source, event bridging, and how duplicate capabilities are removed.
6. Documentation must not describe a second Agent, permission, credential, session, or model implementation that bypasses AgentCore CLI/SDK.
7. Dependency upgrades must update versions, capabilities, and compatibility notes in the relevant docs (the SDK type-declaration/changelog check itself is in [agentcore-runtime-scope.md](agentcore-runtime-scope.md) Compatibility).
8. When the Renderer entry split, session pane cache, timeline rendering/folding, scroll anchoring, queue following, or message persistence restore behavior changes, also review [Renderer session timeline and scrolling rules](renderer-session-timeline.md) and the architecture/product baseline; do not update JSX alone while leaving stale directory or behavior descriptions.
9. Documentation must not describe the Renderer runtime `activity` / `completedActivity` as AgentCore Session persistence fields; AgentCore's raw thinking/tool content and presentation-layer inferred summaries must be clearly distinguished.

## Pre-commit Checks

```bash
rg -n "utilityProcess|MessagePort|Zod|Zustand|Monaco|xterm|agentcore-adapter|permission-engine" docs README.md
rg -n "App\.tsx|app-conversation|timeline-utils|use-conversation-scroll|overflow-anchor|completedActivity" docs rules README.md
# The timeline is deliberately not virtualized. Any hit here means a doc or the
# code drifted back toward a virtual list; see renderer-session-timeline.md §4.
rg -n "react-virtual|useVirtualizer|virtualiz" docs rules README.md apps/desktop/src packages/*/src
rg -n "PfsaaHostCommand|PfsaaRuntimeEvent|interface PfsaaBridge" packages/contracts/src/index.ts
npm run typecheck
npm run test:renderer
npm run build
```

If an architecture term or capability found by these searches does not exist in the current code, remove it, mark it "planned", or complete the implementation before keeping it.
