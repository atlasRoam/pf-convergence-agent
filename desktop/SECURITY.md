# Security Policy

PFSAA handles Provider API keys, OAuth credentials, and session data. Security issues are taken seriously.

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities. Report through
[GitHub Private Vulnerability Reporting](https://github.com/atlasRoam/pf-convergence-agent/security/advisories/new).

Repository maintainers must keep Private Vulnerability Reporting enabled before
making the repository public. The report form is available from the repository's
**Security** tab under **Report a vulnerability**.

Please include:

- Affected versions and environment (OS, Node.js version, Electron version)
- A minimal reproduction or proof of concept
- Impact description and any suggested mitigation

You will receive an acknowledgment within 5 business days, and a timeline for resolution and disclosure.

## Scope

The following are in scope:

- Code execution, privilege escalation, or sandbox escape in the Electron main/renderer process
- Unsanctioned access to Provider credentials, OAuth tokens, or session data
- Path traversal or arbitrary file read/write through PFSAA features
- Supply-chain tampering in dependencies or CI

Out of scope:

- Credential handling and session storage implemented inside the AgentCore CLI / SDK runtime (report to the [AgentCore project](https://github.com/earendil-works/pi) instead)
- Provider (Anthropic, OpenAI, etc.) platform issues
- Local machine compromise where the attacker already controls the user account

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

Security fixes are released on the latest version. Patch releases may be cut for critical vulnerabilities.
