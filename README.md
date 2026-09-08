# quiver-cli

Quiver V2 installs skills from direct GitHub sources, plus custom skills,
commands, provider plugins and MCP servers from catalogs. Each installed entry
has its own source pin and drift baseline. Runtime output remains native to
OpenCode, Claude Code and Codex; there is no extra agent runtime.

**Release status:** this branch documents V2, targeting 2.0.0. The published
CLI remains 1.3.1 until the V2 release; use a source build to try these contracts.

- Commit `.agents/` and `quiver.lock`. They are the project's local source of truth.
- Generate provider files with `sync`; do not edit or commit generated output.
- Use `check` for local drift and MCP snapshots, and `update` for source changes.
- Catalog content lives in [quiver-catalog](https://github.com/nbialk/quiver-catalog),
  not in the CLI package.

## Why V2?

In V1, "up to date" meant matching the configured catalog. With the default
bundled catalog, external skill updates depended on a catalog import and a new
CLI release. V2 removes that bottleneck: external skills track their original
repositories, while custom and curated content stays in a separate catalog.
Each installation keeps its own source revision; updates remain explicit.

Read the [V2 guide](https://github.com/nbialk/quiver-cli/blob/main/docs/v2.md)
for the motivation, release highlights, breaking changes and upgrade walkthrough.

## Quick Start

Requires **Node >= 20.12.0**. From the target repository, choose one setup:

```bash
quiver-cli init          # interactive entry and provider selection
quiver-cli init --empty  # alternative: local setup, no catalog fetch or network
```

`init --all` explicitly selects all eligible catalog entries. `--yes`/`-y`
confirms defaults, not selection of everything. Non-interactive selection needs
`--all` or `--empty`; JSON mode never opens a picker. Initialization preserves
existing local content and refuses to replace an existing lockfile.

```bash
quiver-cli add                         # browse remaining catalog entries
quiver-cli add mcp:context7            # select one entry
quiver-cli add --all                   # explicitly select all remaining entries
quiver-cli add github:vercel-labs/agent-skills/skills/react-best-practices --name=react-performance
quiver-cli sync                        # local provider regeneration
quiver-cli check --offline             # local checks only
```

Commit `.agents/`, `quiver.lock` and the generated ignore rules, then restart
your provider to load its configuration. Keep `.env.local` and
`.agents/config.local.json` private and gitignored.

## Sources And Pins

Direct skill sources use `github:owner/repo[/path][#ref]`. The selected directory
must contain `SKILL.md`; accompanying references and scripts are installed too.
Use `--name=<alias>` to choose the installed name without changing its source.

- No `#ref` tracks the repository's default branch, not an assumed `main`.
- A named branch or tag resolves that exact ref on installation and update.
- A full 40-character commit SHA is fixed. Quiver does not select semver ranges
  or automatically switch to a newer version tag.
- A unique bare name is accepted where an entry is expected. Disambiguate with
  `skill:name`, `command:name`, `plugin:name` or `mcp:name` when names overlap.

The default discovery source is `github:nbialk/quiver-catalog`. Its
`catalog.json` contains pointers to external skills; custom skills, commands,
plugins and MCP definitions live alongside it. `posthog-custom` is the curated
Quiver variant, not an unchanged copy of the original PostHog skills. Choose
an original source explicitly if that is what you want.

Catalog pointers are resolved afresh for **new installs only**. Installed entries
record their own repository/path, requested ref, resolved commit and pristine
source digest in `quiver.lock`. Changing a catalog alias never retargets an
installed entry, and its updates do not depend on that alias remaining available.

Teams can select a custom catalog at initialization:

```bash
quiver-cli init --catalog=github:acme/agent-catalog
quiver-cli init --catalog=github:acme/monorepo/tools/agents#stable
quiver-cli init --catalog=local:/absolute/path/agent-catalog
```

The locator points to the catalog directory itself; append `/.agents` only if
that is where the catalog actually lives. `local:` is for explicit absolute
development paths, never paths relative to the CLI package. Local installations
record their source root, path and digest; they do not invent a Git commit pin.

GitHub downloads use commit-addressed caches under `~/.cache/quiver/catalogs/`
(or `$XDG_CACHE_HOME/quiver/catalogs/`). Private sources require read access via
`GITHUB_TOKEN`, then `GH_TOKEN`, then an authenticated `gh` CLI, in that order.
Authentication, missing paths, invalid refs and rate limits are errors, never
evidence that an entry is up to date.

## Local Drift

`sync` reads installed `.agents/` content and regenerates provider files. It
does not fetch sources, advance pins or accept changed lockfile digests. A fresh
clone can use its committed local files without reaching the catalog.

Normal `check` is project-read-only. It compares content/config digests, provider
files, plugin binary requirements and observed MCP tool descriptions/schemas
against recorded baselines. It does not silently save a first MCP snapshot.

```bash
quiver-cli check --json
quiver-cli check --offline
quiver-cli check mcp:context7 --verbose
quiver-cli check mcp:context7 --accept  # explicitly record the observed snapshot
quiver-cli check skill:cleanup --offline --accept
quiver-cli check --all --accept        # explicit acceptance for all entries
```

Acceptance updates only the selected local baseline and successfully observed
MCP snapshots. It does **not** change the pristine source digest, prove source
authenticity or approve later overwrites of accepted customizations. Missing or
unsafe local artifacts cannot be accepted.

`check --offline` performs no network access and runs no stdio MCP code. Skipped,
missing-baseline or authentication-blocked MCP observations are reported as
incomplete, not current. In JSON output, inspect `complete` as well as `ok`:
an intentional offline skip can pass local checks without certifying live tools.
A missing baseline on a queried server, detected drift or an authentication
failure produces a nonzero exit code.

Stdio introspection requires `--introspect-stdio`, which permits running foreign
code. For OAuth-protected HTTP servers, Quiver can reuse OpenCode credentials
read-only; it does not refresh them. Authenticate with `opencode mcp auth <name>`,
review with `check`, then explicitly accept the snapshot. `inspect <name>` shows
recorded MCP tools, descriptions and estimated token cost without a source fetch.

## Source Updates

```bash
quiver-cli update --dry-run --json
quiver-cli update skill:react-performance
quiver-cli update skill:react-performance --source=github:acme/skills/react#stable --dry-run
```

`update [id]` resolves each installed entry's recorded source independently.
Without an ID it considers all installed entries. A dry run writes nothing in
the project, including the lockfile or provider files; it may populate caches.

Local edits, including previously accepted customizations, are preserved unless
you approve discarding them with `--force`. This is destructive content approval,
not permission to follow a different catalog pointer. Only a targeted
`update <id> --source=github:...` explicitly retargets an entry. An absolute
`--source=local:/path/to/artifact` is also supported for local development.

Application is staged per entry, with rollback for handled I/O failures. Entries
that succeed remain correctly locked if later entries fail. This is not a global
or crash-atomic transaction. If rollback itself fails, recovery backups are
retained under `.quiver-stage-*`; review the reported location before cleanup.
Provider generation is separate: repair derived output with `quiver-cli sync`.

## Migrating From V1

**Migration does not automatically connect old entries to upstream sources.**
Follow the [V2 upgrade walkthrough](https://github.com/nbialk/quiver-cli/blob/main/docs/v2.md#upgrading-an-existing-project)
to migrate metadata first and then review source assignments separately.

V1 projects can still `list`, `sync` and `check` their local installation without
fetching the former bundled catalog. Mutations of the lockfile require migration:

```bash
quiver-cli migrate --dry-run --json
quiver-cli migrate
```

Migration changes metadata only. Installed files, IDs, paths, local digests and
MCP snapshots stay unchanged. Historical origins remain explicitly **legacy and
unverified**; migration neither fetches content nor fabricates source digests.

An old `local:template/.agents` locator is preserved as historical provenance,
not reinterpreted relative to the new package and not automatically mapped to
quiver-catalog or an original author's repository. Legacy entries need a reviewed,
explicit `update <id> --source=github:...` before source updates are possible.
Use direct sources for new additions when the historical discovery catalog is
no longer available. Curated V1 content is never silently replaced by originals.

## Provider Output

Provider behavior is unchanged in V2: all providers consume local installed
content, not the discovery catalog or a live remote source.

| Artifact | OpenCode | Claude Code | Codex |
| -------- | -------- | ----------- | ----- |
| Skills | `.opencode/skills/*` links | `.claude/skills/*` links | native `.agents/skills` |
| Commands | `.opencode/commands/*` | `.claude/commands/*` links | not supported |
| MCP | `opencode.json` | `.mcp.json` | `.codex/config.toml` |
| Settings | `.opencode/tui.json` | `.claude/settings.json` | none |
| Plugins | `.opencode/plugins/*` links | none | none |
| Guide | `AGENTS.md` link | `CLAUDE.md` link | native `AGENTS.md` |

When `.agents/AGENTS.md` exists, root `AGENTS.md` links to it and `CLAUDE.md`
links to `AGENTS.md`, independently of provider selection. Ignore rules for
these generated guides are root-only, so nested source guides remain committable.

`init --providers=opencode,claude` selects providers explicitly; otherwise the
picker offers all three. `providers [a,b]` changes the stored selection and
regenerates output, cleaning deselected providers. `sync` uses that selection;
it no longer accepts `--providers`.

`.agents/config.json` holds MCP/plugin definitions and provider overlays:
`opencode` merges into `opencode.json`, `tui` becomes `.opencode/tui.json`,
`claude.settings` becomes `.claude/settings.json`, and `shared` stays local.
The catalog's `plugin:rtk` adapter requires RTK installed separately; `check`
verifies its binary is on `PATH`.

`disable mcp:<name>` and `enable mcp:<name>` only change gitignored
`.agents/config.local.json` and generated output. They preserve committed config,
pins and snapshots. `list` marks disabled servers, and `check` skips their live
introspection. `remove <id>` removes an installation; local changes require
explicit `--force` approval. `rm` and `ls` remain aliases for `remove` and `list`.

MCP `${VAR}` placeholders use `.env.local`. Generated OpenCode configuration uses
`{env:VAR}`; Codex uses `env_http_headers` for secret headers. Example env files
contain variable names, not credentials. Never commit real secrets or generated
provider files.

## Limits And Safety

- GitHub is the only remote source host. Quiver does not hydrate Git LFS objects
  or submodules.
- Symlinks inside a selected skill are unsupported. Digests cover file bytes
  and relative paths, not executable bits or other file modes.
- Quiver copies direct skill scripts but does not execute them. Provider agents
  may execute installed scripts, commands or plugins; installation is not a
  security guarantee. Review sources and updates before enabling them.
- MCP snapshots expose changes, including possible tool-description poisoning;
  they do not certify a server as safe. See [SECURITY.md](SECURITY.md).

Run `quiver-cli help` for command-specific flags. Value options require `=`,
for example `--name=alias` or `--source=github:owner/repo/path#ref`. There is no
`upstream` or `outdated` command; use `update --dry-run` for source changes.
`version` reports the installed CLI version locally. Optional npm update notices
after online install/update operations can be disabled with
`QUIVER_NO_UPDATE_NOTIFIER=1`; local/offline commands do not trigger them.

## Development

```bash
pnpm install
pnpm typecheck
pnpm vitest run test/package.test.ts
pnpm build
node bin/quiver-cli.mjs help
```

The npm package includes `bin/` and `dist/`, plus npm's standard package metadata,
README and license. It contains no bundled catalog or skill payloads. Contribute
catalog changes to [quiver-catalog](https://github.com/nbialk/quiver-catalog), not
this repository's installed `.agents/`. See [CONTRIBUTING.md](CONTRIBUTING.md).
