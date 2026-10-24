# Security policy

## Supported versions

Security fixes are provided for the latest published minor version. Before `1.0.0`, upgrading to the newest release may include behavior changes described in [CHANGELOG.md](CHANGELOG.md).

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| Older   | No        |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/KenmogneThimotee/plinthway/security/advisories/new). If that is unavailable, email `kenmognethimotee@gmail.com` with the subject `Plinthway security report`.

Include the affected version, impact, reproduction steps, and any proposed mitigation. Remove real credentials and personal data. You should receive an acknowledgement within seven days and a status update after triage. Please allow time for a coordinated fix before public disclosure.

## Security boundaries

Plinthway executes local commands and connects to remote MCP and model providers only when configured by the user. Review [docs/security.md](docs/security.md) before enabling tools or untrusted servers. A vulnerability report should distinguish a policy bypass from behavior explicitly approved by a profile or one-use prompt.
