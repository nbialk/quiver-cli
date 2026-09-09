# Contributing to quiver-cli

This repository owns the V2 CLI: source resolution, installation, lockfiles,
local drift checks and native provider generation. Installable catalog content
is maintained separately in [quiver-catalog](https://github.com/nbialk/quiver-catalog).

## Development Setup

Use Node.js 24 LTS and [pnpm](https://pnpm.io) (see `packageManager`
in `package.json` for the pinned version).

```bash
pnpm install
pnpm build          # tsup -> dist/cli.js
pnpm dev            # tsup --watch
node bin/quiver-cli.mjs help
```

## Verification

Run typechecking and the relevant test file for your change:

```bash
pnpm typecheck
pnpm vitest run test/package.test.ts
pnpm build
node bin/quiver-cli.mjs help
```

`test/package.test.ts` builds an isolated fixture, checks npm's dry-run file list
and invokes the actual bin wrapper. It needs no prebuilt checkout `dist/` and
does not publish. Test CLI dispatch through `bin/quiver-cli.mjs`, not by executing
the exported bundle directly. CI also runs the full test suite.

Use temporary projects and mocked GitHub/MCP responses for behavior tests. Do
not use this repository's installed `.agents/`, `quiver.lock`, credentials or
live third-party services as mutable fixtures.

## Distribution Boundary

The npm `files` allowlist is only `bin` and `dist`; npm adds standard metadata,
README and license files. Do not restore `template/`, vendored external skill
payloads or catalog-maintenance automation to the CLI repository.

The default source is `github:nbialk/quiver-catalog`. Its index supplies external
skill pointers while custom skills, commands, plugins and MCP definitions remain
in that catalog. Curated `posthog-custom` is distinct from original PostHog
sources. The CLI repository's `.agents/` is a real local installation, not the
distribution catalog, and must not be replaced during catalog work.

Test custom catalogs with `init --catalog=local:/absolute/path/catalog` in a
temporary project. A `local:` catalog always names an absolute development
directory. Historical package-relative locators belong only to legacy provenance.

## V2 Contracts

- New installs may follow current catalog pointers. Installed updates use each
  entry's recorded source, never an alias's new target.
- Keep pristine source digests separate from accepted local baselines. `sync`
  fetches nothing and accepts nothing; normal `check` does not write the project.
- `init --empty` and `check --offline` must not access the network. Missing or
  failed observations must not be reported as current.
- `update --dry-run` may fill caches but must not write the project. `--force`
  approves content loss, not implicit source retargeting.
- V1 migration is metadata-only. Keep artifacts, IDs and MCP snapshots intact,
  and leave legacy origins unverified until an explicit source is selected.
- Test per-entry staging and rollback for handled failures, including correctly
  locked partial successes. Provider output is derived and repairable via `sync`;
  do not claim global or crash-atomic transactions.

## Releases

The release-please manifest workflow prepares version and changelog updates
based on Conventional Commits. Merging a release PR creates the GitHub release
and publishes the package to npm through the release workflow.

Do not publish a development checkout to validate packaging. Use the package
test or `npm pack --dry-run --ignore-scripts` after building. Publication remains
an explicitly authorized release operation through the existing workflow.

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/)
and [release-please](https://github.com/googleapis/release-please) for automated
releases. Format:

```text
<type>(<scope>): <subject>
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. The scope is
optional but encouraged (e.g. `feat(catalog):`, `fix(init):`). `feat` and `fix`
commits drive version bumps and changelog entries.

## Pull Requests

1. Fork the repo and create a branch from `main`.
2. Make your changes with tests where it makes sense.
3. Run typechecking, relevant tests and the build; ensure CI passes.
4. Open a PR against `main` with a clear description of what and why.

## Reporting Issues

Use GitHub issues for bugs and feature requests. Include reproduction steps,
the `quiver-cli version` output and your OS/Node version where relevant.
