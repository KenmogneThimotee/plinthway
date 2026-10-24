# Testing and release traceability

## Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
pnpm test:conformance
pnpm test:apps:browser
pnpm test:installed
pnpm audit --prod
pnpm vitest run tests/e2e/installed-package.test.ts
pnpm check
pnpm release:gate
```

`test:e2e` executes the built CLI checks, SQLite restart recovery, scripted TUI checks,
chat-first acceptance coverage, the original acceptance scenarios, and real loopback
stdio/Streamable HTTP MCP integrations. Native local-tool acceptance uses a temporary workspace
and exercises a safe read, approved mutation, approved shell command, explicit denial,
sensitive-read escalation, and path-escape rejection through the real composite provider.
`test:conformance` adds the pinned MCP
`2026-07-28` inventory, all MCP package tests, authorization extensions, and the 25-server
lifecycle scenario. Tests use temporary `PLINTHWAY_HOME` directories, mock providers, and
seeded credentials; they require no real account.

The upstream anchor is `@modelcontextprotocol/conformance@0.2.0-alpha.12` with its frozen
`requirements/2026-07-28.yaml`. `tests/fixtures/mcp/conformance-pins.json` records every
required client scenario, the core schema source, and immutable source revisions for each
official extension. `tests/acceptance/mcp.test.ts` fails when an upstream scenario is
unmapped, an acceptance ID is missing, an extension is absent, or the scale scenario is
skipped.

## Functional-requirement map

| Requirement            | Primary evidence                                                  |
| ---------------------- | ----------------------------------------------------------------- |
| FR-CONFIG / FR-PROFILE | `packages/config`, `packages/profiles`, AT-01–AT-08               |
| FR-REGISTRY            | `packages/model-registry`, AT-09–AT-10                            |
| FR-AUTH                | `packages/auth`, AT-15, AT-TUI-10, secret scan                    |
| FR-LLM                 | `packages/llm-runtime`, mock LLM server, AT-11, AT-16–AT-17       |
| FR-MCP                 | `packages/mcp-client`, transport integration, AT-04, AT-12–AT-14  |
| FR-AGENT / FR-POLICY   | `packages/agent-core`, AT-05, AT-13–AT-17                         |
| FR-SESSION             | `packages/sessions`, restart E2E, AT-07–AT-08, AT-18              |
| FR-CLI                 | `apps/cli/tests/commands`, built and installed package E2E        |
| FR-TUI                 | `apps/cli/tests/tui`, AT-TUI-01–AT-TUI-14                         |
| Chat-first startup     | `tests/acceptance/chat-first.test.ts`, CLI/bootstrap TUI tests    |
| ChatGPT subscription   | `tests/e2e/chatgpt-subscription.test.ts`, auth/runtime unit tests |

## Acceptance map

| IDs                                                          | Executable source                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| AT-01–AT-18                                                  | `tests/acceptance/core.test.ts` and `tests/acceptance/scenarios.ts` |
| AT-TUI-01–AT-TUI-14                                          | `tests/acceptance/tui.test.ts` and `tests/acceptance/scenarios.ts`  |
| Built CLI, offline list, mock-provider run, SIGINT           | `tests/e2e/cli.test.ts`, `tests/e2e/installed-package.test.ts`      |
| Crash/restart and pending tool calls                         | `tests/e2e/recovery.test.ts`                                        |
| Default and alternate keyboard mappings                      | `tests/e2e/tui.test.ts`                                             |
| stdio and Streamable HTTP                                    | `tests/integration/mcp-transports.test.ts`                          |
| Default profile, sync fallback/retry, provider setup, canary | `tests/acceptance/chat-first.test.ts`                               |
| AT-MCP-CORE-01–14, AT-MCP-EXT-01–05                          | `tests/acceptance/mcp.test.ts`, pinned conformance fixture          |
| AT-MCP-SCALE-01                                              | `tests/integration/mcp-scale.test.ts`                               |
| Native OAuth/OIDC and strict Responses tool stream           | `tests/e2e/chatgpt-subscription.test.ts`                            |
| Native filesystem, shell, approval, and containment          | `tests/acceptance/local-tools.test.ts`                              |

## MCP acceptance map

| IDs               | Capability surface                                                                   |
| ----------------- | ------------------------------------------------------------------------------------ |
| AT-MCP-CORE-01–05 | modern negotiation/metadata, tools/schema, prompts, resources, pagination/cache      |
| AT-MCP-CORE-06–10 | roots, sampling, elicitation, progress/cancellation/logging, MRTR                    |
| AT-MCP-CORE-11–14 | OAuth, transports, boundary validation                                               |
| AT-MCP-SCALE-01   | 25 servers, eight-way concurrency, timeout, failure, reconnect, refresh, replacement |
| AT-MCP-EXT-01–05  | Tasks, Skills, Apps, Client Credentials, Enterprise-Managed Authorization            |

Every ID is executed through `it.each`; there is no allowlist for skips or expected
failures. The upstream requirement mapping is bijective, so duplicate and omitted scenario
assignments fail the meta-test.

The ChatGPT suite is hermetic: it signs a fixture ID token, completes a real loopback callback, captures the strict Responses request, and streams a namespaced tool call without using a real account. CI never performs live plan inference. For an opt-in manual smoke test, run `plinthway auth login chatgpt`, choose a model in `plinthway chat`, invoke a harmless read-only tool, restart Plinthway, and confirm the account remains connected. Disconnect the test registration afterward.

The scenario table has a meta-test for the exact ID sets, and scenarios are never skipped. Unexpected remote network is absent from the Plinthway test suite; provider/MCP network tests bind loopback only.

## Benchmark observations

Benchmarks are observations, not flaky CI thresholds. On 2026-10-17, Node v24.22.0, Linux x64, in this development container, representative warm runs observed:

| Operation              |      p50 |      p95 |
| ---------------------- | -------: | -------: |
| Cached registry lookup | 0.032 ms | 0.060 ms |
| Local model resolution | 0.042 ms | 0.080 ms |

Catalog fixtures include three models across two providers. Re-run `packages/model-registry/src/registry.benchmark.test.ts` and `packages/llm-runtime/src/resolver.benchmark.test.ts` when the schema or resolver changes.

`pnpm audit --prod` reported no known vulnerabilities on 2026-10-17. Re-run it for every release; high or critical findings must be fixed or documented with a precise reachability rationale.

## Bun evaluation

Bun is evaluated separately and allowed to fail in CI. Pure shared/config/profile tests and the already-built CLI smoke are attempted. The MVP remains Node-only because `node:sqlite`, Ink terminal behavior, and native keyring compatibility are not replaced or weakened merely to claim a second runtime.

Local observation on 2026-10-17: Bun 1.3.11 passed all 49 shared/config/profile tests, but the built CLI could not resolve `node:sqlite`. That is the current concrete reason Bun remains non-gating and unsupported for production execution.
