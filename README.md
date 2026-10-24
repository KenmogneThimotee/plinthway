# Plinthway

[![CI](https://github.com/KenmogneThimotee/plinthway/actions/workflows/ci.yml/badge.svg)](https://github.com/KenmogneThimotee/plinthway/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/plinthway.svg)](https://www.npmjs.com/package/plinthway)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Plinthway is a local-first, policy-controlled terminal runtime for AI models, native tools, and Model Context Protocol servers. It is built for developers who want a capable agent without giving prompts implicit control over credentials, tools, providers, or session policy.

Each named profile fixes the model, enabled MCP servers, tool rules, instructions, limits, and persistence behavior. Profile changes are explicit, and an existing session keeps its immutable profile snapshot.

## Highlights

- Search the complete [Models.dev](https://models.dev/) catalog, grouped by provider, while execution remains limited to compatible built-in adapters.
- Use OpenAI, Anthropic, Google Gemini, OpenAI-compatible endpoints, or an eligible ChatGPT Plus/Pro subscription.
- Connect many MCP servers explicitly and keep connection choices across sessions.
- Use the MCP `2026-07-28` client surface, initialization-based 2025 fallback, and opt-in Tasks, Skills, Apps, OAuth Client Credentials, and Enterprise-Managed Authorization extensions.
- Run built-in `filesystem.*` and `shell.run` tools behind path policy and one-use approvals.
- Keep credentials in the operating-system keyring, with encrypted-file fallback only for API-key flows when explicitly configured.
- Continue offline from the last valid model catalog cache. Telemetry and cloud sync are off.

## Install

Plinthway requires Node.js 24.

```bash
npm install --global plinthway
plinthway --version
```

Or run it from source:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/main.js --help
```

## Quick start

```bash
plinthway chat
```

The first command creates private local state and an empty selected `default` profile. In chat, choose a provider and model with `/model`; type to search every provider and model immediately. Results are marked `ready`, `setup required`, or `adapter required`.

Useful commands:

```bash
plinthway run "summarize this repository"
plinthway profile list
plinthway models list
plinthway auth login chatgpt
plinthway mcp list
```

Inside chat, `/model`, `/provider`, `/auth`, `/profile`, `/mcp`, `/tools`, `/sessions`, `/new`, `/status`, and `/help` open interactive helpers. Enter submits, Shift+Enter adds a line, Ctrl+P opens the command palette, and Ctrl+C cancels before exiting on a second press.

## Add and connect an MCP server

A remote server needs only a URL. Adding does not connect automatically:

```bash
plinthway mcp add --label "Reference Docs" --url https://mcp.example.com/mcp
plinthway mcp list
plinthway mcp connect reference-docs
```

Use `/mcp` in chat to select a configured server and connect or disconnect it. The enabled state persists across later sessions until you disconnect it. Remove a server with `plinthway mcp remove <server>`.

For a local stdio server:

```bash
plinthway mcp add workspace-files -- npx -y @modelcontextprotocol/server-filesystem /workspace
plinthway mcp connect workspace-files
```

See [MCP configuration and operations](docs/mcp.md) for authentication, extensions, security rules, and troubleshooting.

## Credentials and safety

Tool access is evaluated before every invocation. An `ask` decision authorizes one exact call; changed arguments require another decision. Native filesystem writes, moves, removal, directory creation, and shell commands ask by default. Model-provider credentials are scoped by profile and provider and are never written to profiles, sessions, exports, logs, or model-catalog metadata.

Models.dev package and documentation fields are inert metadata. Plinthway never auto-installs or dynamically imports packages named by the catalog. There is no automatic profile routing, multi-agent orchestration, marketplace, hosted execution, desktop GUI, or silent fallback from ChatGPT plan usage to API billing.

Read the [security model](docs/security.md) before enabling tools or untrusted MCP servers. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Migrating from Local Agent Harness

On the first run, when the Plinthway destination is absent, Plinthway non-destructively copies legacy configuration, profiles, cache, encrypted credentials, ChatGPT metadata, and a consistent SQLite snapshot. It reads the old location from `HARNESS_HOME` when set, otherwise from the former platform-default `harness` directories. Existing Plinthway state always wins, and legacy files are never deleted or overwritten.

Credentials stored under the old operating-system keyring service are adopted on first read. Signing out clears both the current and legacy entries. The old `HARNESS_CREDENTIAL_PASSPHRASE` remains a read-compatible fallback for a migrated encrypted credential file; use `PLINTHWAY_CREDENTIAL_PASSPHRASE` going forward. There is intentionally no `harness` executable alias.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:conformance
pnpm test:apps:browser
pnpm test:installed
```

The supported development runtime is Node.js 24 and pnpm 10.18.3. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [docs/testing.md](docs/testing.md) for the acceptance matrix.

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [MCP configuration and operations](docs/mcp.md)
- [Security model](docs/security.md)
- [Testing](docs/testing.md)
- [Maintainer release process](docs/releasing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)

Plinthway is available under the [MIT license](LICENSE).
