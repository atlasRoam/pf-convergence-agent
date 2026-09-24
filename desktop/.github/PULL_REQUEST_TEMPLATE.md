## Summary

Describe the user-visible or maintenance outcome and link related issues.

## AgentCore capability mapping

- Which AgentCore CLI / SDK API, event, or resource is authoritative?
- Does this change preserve the Renderer → Preload → Main → PiHost boundary?

## Verification

- [ ] `npm run notices:check`
- [ ] `npm ls --all`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:renderer`
- [ ] `npm run build`
- [ ] PiHost/runtime IPC smoke completed when relevant
- [ ] English and Chinese documentation/copy updated together

## Screenshots

Add screenshots for user-interface changes, or write “Not applicable.”

## Security and release impact

Describe credential, filesystem, IPC, packaging, signing, or migration impact.
