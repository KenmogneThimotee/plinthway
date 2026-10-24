# Troubleshooting

## Models.dev is offline

Chat refreshes Models.dev on every launch and uses the last checksum-verified catalog if the request fails. With no valid cache, chat shows only Retry and Exit because model selection cannot be completed safely. Reconnect once to seed the cache. Invalid downloads are rejected without replacing the current generation.

## Linux keyring is locked or unavailable

Unlock the desktop secret service and retry `/provider`, `/auth`, or `plinthway auth login`. Model-provider credentials deliberately have no environment or encrypted-file fallback. Never put the key in global/profile YAML.

## Missing authentication

Run `/auth` in chat, or `plinthway auth status <provider> [--profile <id>]` followed by `plinthway auth login <provider> [--profile <id>]`. The failed message and exact composer text remain visible for retry. Exit code 3 denotes credential/auth failures.

For ChatGPT, run `plinthway auth status chatgpt` and `plinthway auth accounts`. A `reauthentication-required` registration had a terminal refresh failure; reconnect it with `plinthway auth login chatgpt --connection <id>`. Declined plan sharing or an ineligible account must be resolved in ChatGPT before retrying. A plan usage-limit error is not an API-key prompt: wait for the plan limit to reset or deliberately configure the separate `openai` provider if API billing is desired.

If a browser cannot open, retry with `plinthway auth login chatgpt --no-browser --port 1455` and open the printed URL. On SSH, forward the same port to the remote loopback address. The callback must arrive at `/auth/callback`; do not expose the callback listener on a public interface.

## MCP server failed

Use `plinthway mcp list` and `plinthway mcp test <server>`. Adding a remote server does not connect it: run the exact `plinthway mcp connect <generated-or-explicit-id>` command printed by `mcp add`. Check the executable, arguments, working directory, allow-listed environment names, HTTPS/loopback URL rule, and profile `mcp.enabled` list. For local HTTP aliases such as `api.local.test`, confirm every DNS answer is loopback; mixed or changed answers are rejected as possible rebinding. A failed profile activation rolls back to the old usable profile.

`mcp connect` persists enablement before it attempts the connection. If OAuth, token exchange, or
initialization fails, the command exits nonzero and the server remains enabled for later retries;
run `plinthway mcp connect <server>` again after correcting the problem, or
`plinthway mcp disconnect <server>` to disable it. A successful browser page means only that Plinthway
received the callback. Wait for the terminal to report `ready`. Exit code 3 identifies an
authentication failure, while exit code 4 identifies a server that did not become ready.

The list status distinguishes retryable `reconnecting`, permanent `incompatible`, and
`auth-required`. One failed server does not block healthy servers. Confirm that modern
servers advertise `2026-07-28`; legacy servers must support an initialization-based 2025
revision. The removed HTTP+SSE transport cannot be enabled.

For OAuth, use `plinthway mcp connect <server>` or start it separately with
`plinthway mcp auth <server>`. Verify protected-resource and authorization metadata, the configured
resource/scopes, and the callback URL printed by the CLI. HTTP authorization and token endpoints
are accepted only when their hostname resolves exclusively to loopback addresses. Client
Credentials and Enterprise modes must have their matching extension flag enabled. A
managed enterprise file must be at the platform administrator path, have safe POSIX mode,
include `openid`, and contain exactly one registration for the MCP resource.

If a server reconnects but capabilities look stale, wait for its state to return to
`ready`; catalogs are intentionally removed during the gap and atomically repopulated.
Tasks can resume after restart, but App sessions and OAuth PKCE transactions are ephemeral.

## Catalog cache is corrupt

Stop Plinthway and back up the cache directory for diagnosis. Remove only the corrupt catalog generation/current metadata, then run `plinthway models sync`. Do not delete the SQLite database. The previous catalog generation is retained for rollback where possible.

## An interrupted session appears after restart

This is deliberate recovery. The terminal process ended while execution was `running`; committed history is intact and unresolved tool calls are identified. Resume read-only, retry explicitly, or branch. A restart never silently replays a side effect.

## Terminal key conflicts

Set alternate strings in `keymap`, especially `newline` when Shift+Enter cannot be distinguished. `/help` lists alternatives. Escape closes overlays, and two-stage Ctrl+C cancels first and exits second.

## Database backup and restore

Stop all Plinthway processes. Copy `plinthway.sqlite` together with any `-wal` and `-shm` files, or use SQLite's online backup facility. Restore the set to the same data directory with owner-only permissions. On startup, migrations run forward and incomplete executions are marked interrupted. Never hand-edit snapshots or hashes.

## Runtime errors

Use Node 24.x. `node:sqlite`, Ink, and native keyring behavior are part of the supported baseline. Node 22 and Bun are compatibility observations only and may fail before command dispatch.
