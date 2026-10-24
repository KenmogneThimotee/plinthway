# MCP client

Plinthway is a dual-era MCP client. It prefers the stateless `2026-07-28` protocol,
including per-request protocol, client identity, and capability metadata, and negotiates
back only to initialization-based 2025 revisions advertised by a server. It supports up
to 25 enabled servers per profile, starts at most eight connections at once, and commits a
profile after a ten-second activation budget even when some servers remain unavailable.

## Server configuration

Servers live in a profile's `mcp.yaml`; `profile.yaml` selects them by ID. MCP schema v2
adds roots and retains strict server definitions:

The CLI adds a remote Streamable HTTP server from its URL alone. Adding a server only saves
its configuration; connect it explicitly to enable it for the selected profile. When the
server ID is omitted, Plinthway derives it from `--label`, then falls back to the endpoint's
host, port, and path:

```bash
plinthway mcp add --label Docs --url https://mcp.example.com/mcp
plinthway mcp connect docs
```

A generated ID is a lowercase ASCII slug. IDs that begin with a number or collide with the
reserved `filesystem` and `shell` namespaces receive an `mcp-` prefix, so `--label 9docs`
produces `mcp-9docs`. The add result always prints the ID and exact connect command. To
choose the namespace directly, keep supplying it positionally:

```bash
plinthway mcp add company-docs --url https://mcp.example.com/mcp
```

Use `--profile <id>` to target a profile other than the selected one. Existing server IDs
are protected unless `--force` is supplied; generated collisions are never auto-numbered or
silently replaced. The connection choice is persisted, so enabled
servers reconnect in later sessions until `plinthway mcp disconnect <server>` is run. The same
operations are available in chat as `/mcp connect <server>` and `/mcp disconnect <server>`.
Remove a saved server from one profile with:

```bash
plinthway mcp remove <server> --profile <id>
```

Removal also clears that server from the profile's enabled set and tool-policy rules, then
refreshes the active MCP runtime so an open connection is closed. OAuth credentials are retained
because the same endpoint credential can be shared by another profile or server entry.
For a stdio server, put the executable and its arguments after `--` so their flags are not
parsed as Plinthway options:

```bash
plinthway mcp add workspace-files -- npx -y @modelcontextprotocol/server-filesystem /workspace
```

`filesystem` and `shell` are reserved for Plinthway's always-available native tool providers, so they cannot be MCP server IDs. `/mcp` lists only configured MCP servers; `/tools` combines connected MCP tools with native tools and identifies each source.

Changing MCP connections in chat branches an existing conversation onto a fresh profile snapshot.
Resuming an older saved snapshot whose MCP selection differs from the current profile requires an
explicit branch, so it cannot silently reconnect a server that was later disconnected.

Remote servers added this way support OAuth discovery without requiring auth flags. Public servers
still receive an unauthenticated initial request. `plinthway mcp connect <server>` detects an OAuth
challenge, opens the authorization flow, waits for the callback and token exchange, then reconnects
the server. The command succeeds only after the server reaches `ready`. The browser callback page
only confirms that the authorization response was received; the terminal reports whether token
exchange and MCP initialization actually completed. `plinthway mcp auth <server>` remains available
to start authorization separately for an already enabled server.

```yaml
schemaVersion: 2
enabled: [workspace, knowledge, automation]
roots:
  - uri: file:///home/me/project
    name: Project
servers:
  workspace:
    transport: stdio
    command: npx
    args: [-y, '@example/files-server']
    env: [PATH]
  knowledge:
    transport: streamable-http
    url: https://mcp.example.com/mcp
    auth:
      mode: oauth
      clientId: plinthway-cli
      scopes: [mcp:read]
    extensions:
      tasks: true
      skills: true
      apps: false
      oauthClientCredentials: false
      enterpriseManagedAuth: false
  automation:
    transport: streamable-http
    url: https://automation.example.com/mcp
    auth:
      mode: bearer
      credential: { source: keyring, id: automation-token }
```

The allowed HTTP authorization modes are `none`, `bearer`, `oauth`,
`client-credentials`, and `enterprise`. Secrets are references to keyring records, never
literal YAML values. HTTP must use HTTPS except for loopback development. A local DNS alias
such as `http://api.local.test/mcp` is allowed only while every resolved address is loopback;
the same rule covers discovered OAuth registration and token endpoints. The check is repeated for
redirects and when opening the socket; an ordinary, unrestricted SDK fetch does not receive this
HTTP exception. Stdio commands
run without a shell and receive only platform essentials plus the named `env` entries.

All extensions are off and unadvertised unless their corresponding boolean is true:

- `tasks`: `io.modelcontextprotocol/tasks`
- `skills`: `io.modelcontextprotocol/skills`
- `apps`: `io.modelcontextprotocol/ui`
- `oauthClientCredentials`: `io.modelcontextprotocol/oauth-client-credentials`
- `enterpriseManagedAuth`: `io.modelcontextprotocol/enterprise-managed-authorization`

Client Credentials must also select `client-secret-basic`, `client-secret-post`, or
`private-key-jwt`, bind an issuer and keyring credential, and explicitly enable its
extension:

```yaml
auth:
  mode: client-credentials
  issuer: https://auth.example.com
  clientId: plinthway-service
  authentication: private-key-jwt
  credential: { source: keyring, id: plinthway-signing-key }
  algorithm: RS256
  scopes: [mcp:read]
extensions:
  oauthClientCredentials: true
```

## Enterprise-managed authorization

Enterprise profiles cannot be supplied or overridden by user profiles. Administrators
install `managed-auth.yaml` at `/etc/plinthway/managed-auth.yaml` on Linux,
`/Library/Application Support/Plinthway/managed-auth.yaml` on macOS, or
`%ProgramData%\Plinthway\managed-auth.yaml` on Windows. On POSIX the file must not be group-
or world-writable.

```yaml
schemaVersion: 1
profiles:
  workforce:
    issuer: https://id.example.com
    clientId: plinthway-desktop
    clientCredential: { source: keyring, id: idp-client-secret }
    scopes: [openid, profile, email]
    resources:
      - resource: https://mcp.example.com/mcp
        authorizationServer: https://auth.example.com
        clientId: plinthway-managed-mcp
        credential: { source: keyring, id: managed-mcp-secret }
        scopes: [mcp:read]
```

The matching server entry contains only `auth: { mode: enterprise, managedProfile:
workforce }` and `extensions: { enterpriseManagedAuth: true }`. Login uses OIDC with
PKCE, state, nonce, issuer, audience, signature, and expiry validation. Identity assertions,
ID-JAGs, access tokens, private keys, and client secrets stay in the credential vault.

## Capabilities and lifecycle

The manager aggregates tools, prompts, resources, templates, completions, Tasks, Skills,
and Apps while retaining the owning server ID. It also handles roots, sampling, both
elicitation modes, progress, cancellation, subscriptions, logging, response caching, and
multi-round-trip requests. Lists stop after 64 pages, MRTR stops after eight rounds, and
bounded payloads fail closed.

Connection failures are isolated. `plinthway mcp list` also reports configured, disabled servers
as `disconnected`; enabled servers report `connecting`, `ready`,
`auth-required`, `reconnecting`, `degraded`, `incompatible`, or `closed`, plus negotiated
protocol, extensions, retry time, and a redacted error. Reconnects use bounded jittered
backoff. Catalogs disappear immediately when a connection is lost and are rebuilt
atomically when it returns. Profile replacement closes the prior generation and prevents
late retries or notifications from crossing the boundary.

## Migration from schema v1

Schema v1 is accepted and normalized to v2 with an empty roots list. A deliberate migration
is simply:

```diff
- schemaVersion: 1
+ schemaVersion: 2
  servers: { ... }
  enabled: [files]
+ roots: []
```

Legacy `authPlugin` Streamable HTTP entries are accepted as keyring-backed bearer auth for
compatibility. Replace them explicitly:

```diff
  transport: streamable-http
  url: https://mcp.example.com/mcp
- authPlugin: company-mcp-token
+ auth:
+   mode: bearer
+   credential: { source: keyring, id: company-mcp-token }
+ extensions: {}
```

Dynamic OAuth client registration, roots, sampling, and logging remain interoperable for
older servers but are deprecated by the 2026 revision. Prefer a configured client ID or
Client ID Metadata Document, explicit resource handles instead of protocol sessions, and
the modern server capabilities. The removed 2024 HTTP+SSE transport is intentionally not
supported; move those endpoints to Streamable HTTP.
