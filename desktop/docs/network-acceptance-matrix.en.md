# PFSAA Network Acceptance Matrix

This matrix validates the real PfsaaHost → AgentCore runtime → Provider path. It is intentionally separate from renderer-only settings round-trip checks: every transport cell must complete a real GPT-5.5 request and persist the assistant response in the AgentCore Session.

## Matrix

| Cell | AgentCore setting | Boundary exercised | Pass criteria |
| --- | --- | --- | --- |
| N-01 | `auto` | AgentCore's automatic transport selection | A fresh Session selects the configured GPT-5.5 model, completes the prompt, and persists the exact marker in `sessions.messages` |
| N-02 | `sse` | Server-Sent Events request/stream | Same criteria, with the setting read back as `sse` before the prompt |
| N-03 | `websocket` | WebSocket request/stream (non-cached context) | Same criteria, with the setting read back as `websocket` and no persisted `provider_transport_failure` fallback diagnostic |
| N-04 | `websocket-cached` | WebSocket connection/context reuse | Two sequential prompts complete in one Session, both markers are persisted, and no persisted `provider_transport_failure` fallback diagnostic appears |
| N-05 | isolation | Credentials/settings safety | Each cell uses a temporary copy of the configured AgentCore agent directory and workspace; the user's `settings.json`, sessions, and credentials are never written |
| N-06 | cleanup | Session lifecycle | The temporary Session, workspace, agent copy, and child PfsaaHost are removed even when a cell fails |

## Run

Build the current PfsaaHost, then run:

```text
npm run acceptance:network
```

The runner discovers exactly one authenticated model whose Provider/model name matches GPT-5.5. If more than one is configured, select one explicitly with `PFSAA_ACCEPTANCE_MODEL=provider/model`. `PFSAA_ACCEPTANCE_TIMEOUT_MS` can raise the per-request timeout for a slow Provider.

The command exits non-zero if any matrix cell fails and prints one JSON result per cell. It does not claim success from a saved setting alone: a cell is green only after `agent.prompt` returns `completed` and the marker is found in the persisted Session messages.

## Failure interpretation

- `settings.get` mismatch: PfsaaHost did not load the requested transport from AgentCore's authoritative SettingsManager.
- `agent.setModel` or model discovery failure: the configured GPT-5.5 credentials/model catalog is unavailable; this is not converted into an offline pass.
- Prompt timeout/error: the selected transport or Provider path did not complete a real request.
- Explicit WebSocket fallback diagnostic: AgentCore reached SSE fallback instead of proving the requested WebSocket path.
- Persistence failure: the Provider answered, but AgentCore Session storage did not retain the response.

The matrix complements `npm run smoke:runtime` (IPC and offline capability smoke), `npm run smoke:cli` (CLI compatibility), and the optional CDP UI settings smoke. It is not a substitute for a visual UI review.
