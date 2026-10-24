# Configuration

## Locations and precedence

Set `PLINTHWAY_HOME` to place all local state below one directory. Otherwise Plinthway uses the platform conventions: XDG directories on Linux, `~/Library/Application Support` and `~/Library/Caches` on macOS, and `%APPDATA%`/`%LOCALAPPDATA%` on Windows.

Resolution order is built-in defaults, global YAML, then explicit command/runtime overrides. Each profile is a self-contained directory with `profile.yaml`, `providers.yaml`, and `mcp.yaml`. Existing sessions do not re-resolve edited profiles; they retain the effective snapshot captured at creation.

Every command creates missing private configuration/data/cache/profile directories, `config.yaml`, the SQLite database, and—only when the profile collection is empty—an empty selected `default` profile. `plinthway init` remains an idempotent automation command, but it is not required before `plinthway chat`.

## Global configuration

```yaml
schemaVersion: 1
registry:
  source: https://models.dev/api.json
  cache: true
  refreshIntervalHours: 24
providers:
  openai:
    adapter: openai
    authPlugin: openai-api-key
    models: {}
  anthropic:
    adapter: anthropic
    authPlugin: anthropic-api-key
    models: {}
  google:
    adapter: google
    authPlugin: google-api-key
    models: {}
  local:
    adapter: openai-compatible
    authPlugin: none
    baseURL: http://127.0.0.1:11434/v1
    models: {}
mcpServers: {}
security:
  defaultToolPolicy: deny
  allowedHttpOrigins: []
keymap:
  commandPalette: ctrl+p
  submit: enter
  newline: shift+enter
  close: escape
  cancel: ctrl+c
  complete: tab
```

Remote provider endpoints require HTTPS. MCP configuration accepts HTTP or HTTPS so an endpoint can be saved before it is connected, but the MCP runtime permits plain HTTP only for literal loopback hosts or DNS aliases whose complete address set is loopback. Public, mixed, and private non-loopback HTTP destinations remain denied. Model IDs are fully qualified as `provider/model`; the first slash separates provider from model, so model names may contain further slashes.

Models.dev data is metadata, not authority: configured adapters, credentials, and required capabilities are checked locally. A malformed update never replaces the last good generation.

### Model catalog picker

In chat, `/model` opens every validated Models.dev model together with profile-local models and models discovered from a connected ChatGPT account. Results are grouped by provider and can be searched by provider name/ID, model name/ID, or the complete `provider/model` reference. Type to filter, use Up/Down or PageUp/PageDown to move, Backspace to edit, Ctrl+U to clear, Enter to act on the selection, and Escape to close. The visible list is bounded to the terminal height even when the catalog contains thousands of models.

Each provider has one execution status:

- `ready`: the active profile has a registered adapter and the required credential.
- `setup required`: Plinthway has a compatible built-in setup path. Selecting the model prefills the provider, endpoint, and model; only authentication or no-auth confirmation remains.
- `adapter required`: the provider remains searchable, but no compatible registered adapter is available. The detail view shows package, authentication, endpoint, and documentation metadata and makes no profile change.

Selection and credentials are profile-scoped. Choosing a model in one profile does not configure another profile, and a successful change starts a new session while older session snapshots remain unchanged. If Models.dev is offline, the picker uses the last validated cache and marks it as cached. A ChatGPT account-refresh error is shown on that provider group without hiding the base catalog.

Catalog package names and documentation URLs are display-only. Plinthway does not run package-manager commands, auto-install packages, dynamically import catalog values, or open documentation links automatically. Runtime support is supplied only by compatible built-in adapter declarations.

## Profile bundle

`profile.yaml` owns behavior and model selection:

```yaml
schemaVersion: 1
id: coding
name: Coding
model:
  primary: openai/gpt-5
  fallback: []
  parameters:
    temperature: 0.2
mcp:
  enabled: [files]
tools:
  defaultPolicy: deny
  rules:
    - tool: filesystem.remove
      action: deny
    - tool: shell.run
      action: ask
    - tool: files.read
      action: allow
    - tool: files.write
      action: ask
agent:
  instructionsFile: ./CODING.md
  maxSteps: 12
  toolTimeoutSeconds: 30
session:
  persist: true
```

`providers.yaml` owns provider endpoints, auth mode, and custom model declarations. The chat provider wizard writes this file and stores API keys separately in the OS keyring under the profile/provider identity:

```yaml
schemaVersion: 1
providers:
  openai:
    adapter: openai
    auth:
      mode: api-key
      credential: keyring
    models: {}
```

`mcp.yaml` owns MCP definitions and the enabled set. Interactive MCP authoring is not part of the current chat wizard.

MCP bundles use schema version 2, support up to 25 enabled servers, and may declare strict
`file://` roots. Stdio and Streamable HTTP examples, all authorization modes, extension
flags, managed enterprise paths, and v1 migration are documented in [MCP client](mcp.md).
Schema v1 is read as v2 with `roots: []`; new writes use v2.

Only exact `namespace.tool` and terminal `namespace.*` rules are accepted. Precedence is exact rule, wildcard rule, intrinsic native default, then profile default. `filesystem` and `shell` are reserved namespaces and cannot be used as MCP server IDs. Native filesystem inspection defaults to `allow`; filesystem mutations and `shell.run` default to `ask`. An explicit deny is final. Side-effecting or sensitive operations are clamped to approval unless explicitly allowed by an exact rule. An enabled MCP server is still not usable unless the discovered tool and policy also permit it.

### Native local tools

Native tools are always present and require a model with tool-call support:

- `filesystem.read_text`, `filesystem.list`, `filesystem.stat`
- `filesystem.write_text`, `filesystem.create_directory`, `filesystem.move`, `filesystem.remove`
- `filesystem.glob`, `filesystem.search_text`
- `shell.run`

Filesystem paths may be relative to the launch workspace or absolute inside it. Parent traversal, outside paths, and symlinks that escape the workspace are rejected. Hidden or sensitive reads such as `.env` are raised from their ordinary read default to approval. Results are bounded: text and aggregate filesystem output are at most 1 MiB, directory lists at most 500 entries, and searches at most 200 matches while scanning at most 100 MiB.

`shell.run` accepts exactly one of `command` or `program` plus `args`; it also accepts an optional workspace-contained `cwd` and up to 1 MiB of stdin. Commands are limited to 16 KiB, argv mode to 256 arguments of 8 KiB each, and stdout/stderr to 512 KiB each with truncation flags. The profile tool timeout applies, and cancellation terminates the process tree. The working directory is contained, but the process itself is not sandboxed and retains the current user's OS filesystem and network authority.

## Environment expansion and credentials

Public configuration strings may reference `${NAME}` (including `${WORKSPACE}`). Missing, recursive, malformed, or secret-looking substitutions fail closed. Values named like tokens, passwords, API keys, cookies, or authorization headers cannot be interpolated into public config.

Model-provider secrets are accepted by the chat wizard or `plinthway auth login <provider> [--profile <id>]`. They are stored only in the OS keyring and keyed by both profile and provider. Environment variables and encrypted files are not fallback sources for model-provider credentials; an unavailable keyring produces `KEYRING_UNAVAILABLE`.

MCP bearer tokens, OAuth registrations/tokens, client secrets, private keys, and enterprise
identity assertions follow the same vault-only rule. Public MCP YAML contains a keyring ID,
never the secret. Enterprise authorization is additionally loaded only from the fixed
administrator-managed platform path and cannot be redirected by an environment variable.

## ChatGPT subscription

`chatgpt` is a reserved, separate provider for eligible ChatGPT plan sharing. It never uses an OpenAI API key and never falls back to API billing. In chat, choose **ChatGPT subscription**, connect an account, and select one of the models returned for that account. The saved profile contains only a local connection ID and non-secret model declaration:

```yaml
providers:
  chatgpt:
    adapter: openai-chatgpt
    auth:
      mode: oauth
      service: chatgpt
      connectionId: 2bfa4c7d-example
    models:
      gpt-test:
        name: GPT Test
        toolCalls: true
```

Use `plinthway auth accounts`, `plinthway auth status chatgpt`, and `plinthway auth logout chatgpt --connection <id>` to manage registrations. A profile export replaces the connection ID with `local-selection-required`; importing it requires selecting a local account again.

For a remote shell, forward the callback port to the machine running Plinthway, then print the URL instead of opening a browser:

```bash
ssh -L 1455:127.0.0.1:1455 user@host
plinthway auth login chatgpt --no-browser --port 1455
```

Models.dev synchronization remains the independent catalog for API-key and custom providers. ChatGPT models come from the connected account and are cached only as non-secret metadata. Subscription models intentionally ignore temperature and maximum-output settings.
