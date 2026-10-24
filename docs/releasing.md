# Releasing

This document is for maintainers.

## Prerequisites

- The version and date are updated in the root and CLI package manifests and `CHANGELOG.md`.
- `pnpm release:gate` passes on Node.js 24.
- The exact package name and version are still available on npm.
- The `npm` GitHub environment has the intended approval rules.
- npm trusted publishing names `KenmogneThimotee/plinthway`, workflow `publish.yml`, and environment `npm`. The package repository URL must match exactly.

## Automated releases

Merge the release commit to `main`, then dispatch **Publish to npm** from that branch. The workflow uses GitHub OIDC and has no long-lived npm token. It builds and verifies the repository again before publishing `apps/cli` with provenance.

After npm reports the expected package and integrity, create the matching signed or annotated `v<version>` tag and GitHub release from the same commit. Attach the CI-generated tarball, SBOM, and checksums when available.

## First publication

An npm trusted publisher can only be attached after the package exists. The first `0.1.0` publication is therefore performed manually from a clean, verified tree with the maintainer’s npm two-factor authentication. Configure the trusted publisher immediately afterward; all later releases use the OIDC workflow.

Never add an npm automation token to repository or environment secrets.
