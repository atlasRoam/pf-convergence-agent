# Electron / PfsaaHost Communication and Validation

## Communication Model

- Renderer -> Preload -> Main IPC -> PfsaaHost -> AgentCore runtime.
- PfsaaHost is started via `child_process.fork` from Electron's bundled Node (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`): when the bundled Node satisfies the AgentCore runtime engines there is no WebIDL/undici compatibility issue, and it reads the asar archive transparently, so node_modules can stay fully packed into the asar with only native `.node` modules and assets unpacked.
- Electron `utilityProcess`'s `process.parentPort` only applies to the Electron utility runtime; PFSAA uses plain Node `child_process.fork`, which must use `process.send` / `process.on("message")`.
- Use an external system Node only when explicitly set via `PFSAA_NODE_EXECUTABLE`: a system Node cannot read asar, so node_modules and the PfsaaHost entry must be unpacked via `asarUnpack`, and the fork path must be mapped to `app.asar.unpacked`.
- Main must listen to the Host's start, message, error, and exit events, and set timeouts for pending requests.

## Smoke Validation

After building, verify at least:

- PfsaaHost runtime status
- `projects.list`
- `models.list`
- `providers.list`
- `sessions.create`
- `sessions.capabilities`
- `sessions.tree`、`sessions.fork`、`sessions.clone`、`sessions.navigateTree`（通过真实 PfsaaHost IPC 验证会话树与会话替换）
- `workspace.snapshot`

Real model prompts produce network and Provider side effects; never run them automatically without explicit user authorization.

## Common Failures

- `PfsaaHost request timed out`: first check whether the Host started and IPC events are being read correctly, then check SDK initialization errors.
- `webidl.util.markAsUncloneable is not a function`: the AgentCore runtime/undici is running on an Electron Node that is too old (missing `markAsUncloneable`). Upgrade Electron so the bundled Node satisfies the AgentCore runtime engines (`>=22.19.0`; Electron 43's bundled Node 24 already satisfies it), or point `PFSAA_NODE_EXECUTABLE` at a suitable system Node and unpack node_modules accordingly.
- Empty model list: distinguish "model catalog empty", "Provider not authenticated", and "IPC request failed"; the UI must not render all three as the same empty state.
- Interactive auth (especially OAuth browser callbacks) is not a normal short request; `providers.login` must allow a long enough wait and keep showing an "authorizing" state. Do not mask pending callbacks with a uniform short timeout.
