# Contributing to quiver-cli

Thanks for your interest in contributing! This document covers the basics for
getting set up and submitting changes.

## Development setup

Requires Node.js `>=20.12.0` and [pnpm](https://pnpm.io) (see `packageManager`
in `package.json` for the pinned version).

```bash
pnpm install
pnpm build          # tsup -> dist/cli.js
pnpm dev            # tsup --watch
```

## Verifying changes

Before opening a pull request, make sure all checks pass — these mirror CI:

```bash
pnpm typecheck
pnpm test
pnpm build
```

When changing a single area, run the relevant test file instead of the full
suite, e.g.:

```bash
pnpm vitest run test/check.test.ts
```

## The catalog

The catalog of installable skills, commands and MCP servers lives under
`template/.agents/`. Edit it to change what `quiver-cli init`/`add` can install.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/)
and [release-please](https://github.com/googleapis/release-please) for automated
releases. Format:

```
<type>(<scope>): <subject>
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. The scope is
optional but encouraged (e.g. `feat(catalog):`, `fix(init):`). `feat` and `fix`
commits drive version bumps and changelog entries.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your changes with tests where it makes sense.
3. Ensure `pnpm typecheck`, `pnpm test` and `pnpm build` pass.
4. Open a PR against `main` with a clear description of what and why.

## Reporting issues

Use GitHub issues for bugs and feature requests. Include reproduction steps,
the `quiver-cli version` output and your OS/Node version where relevant.
