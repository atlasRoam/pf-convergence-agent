# AgentCore Source

This directory contains the AgentCore monorepo: runtime, CLI/TUI, packages, and
core tests. The PFSAA desktop application and its Host integration are in
[`../desktop`](../desktop/README.md). Package names and versions are defined by
their respective `package.json` files.

## Development

Use Node.js `>=22.19.0` and npm. From this directory, install the locked
dependencies with `npm ci`, then use the scripts in `package.json` to test or
build the workspace (`npm test` and `npm run build`).

## Local resources and credentials

This public source snapshot does not bundle project-specific Skills, local
runtime/session data, Provider credentials, proprietary engines, or case data.
Configure any required resources in your own authorized environment. Keep
credentials, transcripts, and private datasets out of version control.

The AgentCore source retains its upstream MIT copyright notices and license;
see [`LICENSE`](LICENSE). PFSAA's separately owned additions follow the root
Apache-2.0 license.
