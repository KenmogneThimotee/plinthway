# Security model

## Trust boundaries

- Prompts, provider output, model reasoning, MCP schemas, and MCP results are untrusted.
- Profiles define the maximum authority for one session. Neither natural language nor tool output can select a profile, enable a server, or alter policy.
- Every tool call is checked against the active immutable snapshot immediately before invocation.
- Approval grants bind session, execution, profile generation, call ID, exact tool name, and canonical argument hash. They are single-use and invalidated by profile changes.

The approval view shows the source, fully qualified tool name, canonical validated arguments, resolved file/URL targets, the read-only hint, and anticipated side effects. Shell approvals explicitly state that the process retains OS filesystem and network authority; sensitive filesystem reads warn about disclosure. The only decisions are `Allow once` and `Deny`; an allow is shown as executing only after its durable decision event is committed.

## Credential handling

Model-provider credentials are isolated by profile and provider and stored only in the platform keyring. A locked or unavailable keyring fails closed; there is no environment-variable or encrypted-file fallback for model providers. ChatGPT access, refresh, and retained ID tokens are also keyring-only. Account metadata, the stable host ID, and model cache contain no tokens and use owner-only atomic files.

ChatGPT authorization binds a loopback listener to `127.0.0.1`, validates state, PKCE, ID-token signature/issuer/audience/expiry/nonce, and requires the direct plan-sharing scope. Production credentials are origin-locked to `https://api.openai.com/v1/responses`; redirects, organization/project headers, custom base URLs, and API-key fallback are rejected. Refresh rotation is checkpointed before the predecessor token is discarded and serialized across processes.

Known secret values and secret-looking keys are recursively redacted from errors and exports. Persistence rejects values whose canonical JSON changes under redaction. Session snapshots, SQLite events, catalog metadata, CLI output, and logs must never contain credentials. The acceptance gate seeds a canary and recursively scans artifacts and output.

## MCP subprocess and network boundaries

Stdio servers are launched without a shell. Profiles select from globally configured servers and pass only allow-listed environment variable names. Processes are closed on rollback, switch, cancellation, and shutdown.

Streamable HTTP requires HTTPS except for loopback development. A non-literal HTTP hostname is accepted only when every DNS answer is loopback. DNS is checked before connection, again by the socket dispatcher, and after every redirect; a public, mixed, private non-loopback, or rebound answer is denied even when its origin is allow-listed. Authentication headers are injected at connection time and never enter public server config. Schemas, arguments, and results are validated; result bodies and text blocks have hard size limits; every call has timeout and cancellation boundaries.

OAuth discoveries, token endpoints, redirects, and enterprise IdP endpoints pass the same
network policy. Resource bearer tokens stay bound to the MCP origin; only Basic client
authentication may reach the exact discovered token endpoint. Secret-bearing form bodies
are never replayed across origins. Issuer/resource/scope bindings and token expiry are
checked before reuse, and all observed secrets are registered with process-wide redaction.

Official MCP extensions are capability-gated and disabled by default. Skills verify every
manifest digest and bound; Apps run in an isolated localhost sidecar with CSP, origin
isolation, ephemeral bridge tokens, allowlisted methods, and normal tool policy; Tasks
persist only sanitized state. Enterprise authorization trusts only the locked machine file
and validates OIDC/ID-JAG signatures, issuer, audience, nonce, resource, scope, and expiry.

## Local data operations

Configuration and credential files use restrictive permissions where the platform supports them. Atomic replacement protects config/cache generations. SQLite uses foreign keys, full synchronous durability, WAL for file databases, ordered events, and transactional state updates. Back up the database only while Plinthway is stopped or via a SQLite-safe backup method.

Native filesystem tools are rooted at the directory from which Plinthway was launched. Paths are canonicalized, traversal and absolute outside paths are denied, directory traversal does not follow symlinks, and existing symlink targets must remain inside the workspace. Ordinary read-only operations have an intrinsic allow policy, but hidden and sensitive reads have an approval risk floor. Mutations have an intrinsic ask policy and use bounded, atomic operations where applicable.

`shell.run` always has an approval risk floor. Its `cwd` must remain in the workspace and its inherited environment is reduced to platform essentials plus `PLINTHWAY_WORKSPACE`, but it is deliberately not an OS sandbox. An approved command can access anything available to the current user and can use the network. Output, stdin, command size, argument count, time, cancellation, and descendant lifetime are bounded.

Telemetry is disabled. The only expected outbound connections are an explicit Models.dev refresh, configured model-provider endpoints, and profile-enabled Streamable HTTP MCP endpoints.
