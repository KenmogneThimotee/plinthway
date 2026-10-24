# Contributing to Plinthway

Thank you for helping improve Plinthway. Bug reports, focused feature proposals, documentation fixes, tests, and code changes are welcome.

## Before opening a change

- Search existing issues and pull requests first.
- Use a GitHub issue for behavior changes large enough to need design agreement.
- Do not include API keys, OAuth tokens, private MCP responses, personal paths, or real profile data in issues, fixtures, logs, or commits.
- Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 24 and pnpm 10.18.3:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Run the CLI from source with:

```bash
node apps/cli/dist/main.js --help
```

Use an isolated home while testing manually:

```bash
PLINTHWAY_HOME=/tmp/plinthway-dev plinthway chat
```

## Pull requests

1. Add or update a failing test before changing behavior.
2. Keep changes focused and preserve security boundaries.
3. Run `pnpm check` locally.
4. For MCP work, also run `pnpm test:conformance`.
5. For terminal App-host changes, run `pnpm test:apps:browser`.
6. For packaging changes, run `pnpm test:installed` and inspect `pnpm pack:cli --dry-run`.
7. Update user documentation and `CHANGELOG.md` when behavior changes.

The complete release gate is `pnpm release:gate`. It requires Chromium for the browser security suite and network access for upstream MCP conformance and the production dependency audit.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and license your contribution under the project’s [MIT license](LICENSE).
