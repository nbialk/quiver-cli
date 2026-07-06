# quiver-cli

Compose a selected subset of skills, slash commands and MCP servers from a
central catalog into any repo — as **native configs** for opencode, Claude Code
and Codex — with **lockfile-based drift awareness**.

One thing done right: repo composition + drift detection. No marketplace, no
extra agents, no command abstraction.

- **One source of truth** — `.agents/` + `quiver.lock`, committed to the repo.
- **Native output** — `.claude/`, `.opencode/`, `.codex/`, `.mcp.json`,
  `opencode.json` are generated and gitignored; each tool loads its own format.
- **Drift detection** — content digests for skills/commands, tool snapshots for
  MCP servers (including tool-description poisoning).
- **Upstream awareness** — know when a source repo updates a skill you imported.

## Quick start

From the root of the target repository:

```bash
pnpm dlx quiver-cli init
```

The interactive picker lets you select skills, commands and MCP servers from
the catalog; quiver then materializes them into `.agents/`, writes
`quiver.lock`, generates the native provider configs and patches `.gitignore`.

```bash
git add .agents quiver.lock .gitignore
git commit -m "chore: add agent config"
```

Restart your AI tool (Claude Code, opencode, Codex) to load the configs.
Day to day:

```bash
quiver-cli add mcp:context7   # add one entry (skill:/command:/mcp:)
quiver-cli sync               # regenerate provider configs from .agents/
quiver-cli check              # detect drift (CI-friendly: --json, exit 1)
```

## Commands

| Command                    | Description                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `quiver-cli init`          | Interactive picker; write native configs + `quiver.lock`          |
| `quiver-cli add <id>`      | Add one entry (`skill:<name>`, `command:<name>`, `mcp:<name>`)    |
| `quiver-cli remove <id>`   | Remove one entry; keep lockfile + configs consistent              |
| `quiver-cli update [id]`   | Pull newer catalog content into `.agents/` (all or one entry)     |
| `quiver-cli sync`          | Regenerate provider configs from `.agents/`; warn on drift        |
| `quiver-cli list`          | Show installed entries incl. MCP tool counts (alias: `ls`)        |
| `quiver-cli check`         | Detect drift: skill digests, provider shims, MCP tool snapshots   |
| `quiver-cli upstream`      | Check source repos for skill updates (catalog maintenance)        |
| `quiver-cli upstream pull` | Pull latest upstream content into the catalog (`[skill]`)         |
| `quiver-cli help`          | Show help                                                         |
| `quiver-cli version`       | Show the version + any available update (`-v`, `--version`)       |

Options: `-f/--force`, `--all/-y` (non-interactive), `--json`
(check/upstream/list), `--providers=claude,opencode` (limit generated
configs), `--catalog=<source>` (catalog source for `init` and `upstream`),
`--offline` (skip MCP re-introspection during `check`), `--introspect-stdio`
(allow running stdio MCP servers during `check`).

## What gets generated

| Artifact | Claude Code              | opencode                    | Codex                          |
| -------- | ------------------------ | --------------------------- | ------------------------------ |
| Skills   | `.claude/skills/*` (link)| `.opencode/skills/*` (link) | native from `.agents/skills`   |
| Commands | `.claude/commands/*`     | `.opencode/commands/*`      | (not supported yet)            |
| MCP      | `.mcp.json`              | `opencode.json`             | `.codex/config.toml`           |
| Guide    | `CLAUDE.md` (link)       | `AGENTS.md` (link)          | `AGENTS.md` (native)           |

`AGENTS.md` at the repo root is a symlink to `.agents/AGENTS.md` (created only
when the catalog ships one); `CLAUDE.md` links to it. Codex reads skills and
`AGENTS.md` natively from the repo, so no shims are emitted for those.

By default configs are generated for all three tools. `init` asks which ones
you use (or pass `--providers=claude,opencode`); the choice is stored in
`quiver.lock`, and deselected tools have their generated files cleaned up on
`sync`.

## The lockfile

`quiver.lock` records, per entry: source path, content digest, and — for MCP
servers — a **tool snapshot** (`{ description, inputSchemaHash }` per tool).
This is the basis for `sync` and `check`.

## `check` — drift awareness

`check` is the single drift command. It compares three things:

- **Skills/commands**: compares the stored digest against the current `.agents/`
  content.
- **Provider shims**: verifies the generated `.claude/`, `.opencode/`, `.codex/`
  configs match the lockfile (missing, stale or out-of-sync files) → fix with
  `quiver-cli sync`.
- **MCP servers** (the real lever): re-introspects `tools/list` and diffs against
  the snapshot → new/removed tools, changed input schemas, and — security
  critical — **changed tool descriptions** (defends against tool-description
  poisoning), shown as a readable before/after.

The first successful introspection records a baseline; subsequent `check` runs
diff against it. Servers that fail introspection (e.g. requiring interactive
OAuth) are reported as skipped. stdio servers run foreign code and are only
introspected with `--introspect-stdio`.

Pass `--offline` to skip MCP re-introspection entirely and check only digests
and provider shims — no network, no foreign code, useful for a fast local
sanity check.

`quiver-cli check --json` is CI-friendly (exit 1 on drift).

## `upstream` — source updates

`upstream` is a **catalog-maintenance** command, not a per-repo one. `check`
detects drift between the lockfile and the repo's `.agents/`; `upstream` answers
a different question: **has the source repo updated a skill since it was
imported into the catalog?**

Because it records baselines (and `pull` rewrites skill copies) **in the catalog
itself**, run it where the catalog is writable — inside the quiver-cli repo, or
against a writable local checkout via `--catalog <path>`. Run from a consuming
repo, where the catalog is the read-only installed package (or a remote cache),
it aborts with guidance; use `quiver-cli check` / `quiver-cli update` there
instead.

Origins live in `template/.agents/upstreams.json` (`repo`, `path`, `ref` per
skill). `quiver-cli upstream` queries the GitHub Commits API for the latest
commit touching each path:

- First run records a baseline commit per skill.
- Later runs report `up to date`, `upstream updated <old> → <new>`, or `skipped`
  (e.g. rate-limited). To lift the anonymous 60 req/h limit, provide a token via
  `GITHUB_TOKEN`/`GH_TOKEN` (env or repo `.env.local`), or just log in with the
  `gh` CLI — its token is picked up automatically.
- Skills flagged `curated: true` are reported as **drift-curated** — they were
  modified after import, so changes must be reconciled by hand.

`quiver-cli upstream pull [skill]` fetches the latest upstream content into the
catalog via a shallow sparse git clone and records the new baseline. Curated
skills are skipped unless `--force` is given. Repos consuming the catalog then
pick the changes up with `quiver-cli update` (local modifications are never
overwritten without `--force`). `quiver-cli upstream --json` is CI-friendly
(exit 1 on drift).

## Remote catalogs

By default `init` uses the catalog bundled with the package. Teams can host
their own catalog in a GitHub repo and point `init` at it:

```bash
quiver-cli init --catalog github:acme/agent-catalog            # .agents at repo root
quiver-cli init --catalog github:acme/monorepo/tools/.agents   # subdirectory
quiver-cli init --catalog github:acme/agent-catalog#v2         # branch or tag
```

The source is recorded in `quiver.lock` together with the **resolved commit
SHA** (`catalog.ref` / `catalog.resolved`):

- `add` installs from the pinned SHA — reproducible, and served from the local
  cache without network when possible.
- `update` re-resolves the ref (branch/tag HEAD), moves the pin forward and
  pulls newer content into `.agents/`.

Catalogs are downloaded via the GitHub tarball API and cached under
`~/.cache/quiver/catalogs/` (content-addressed by commit SHA, immutable).

### Private repos & tokens

For private catalog repos (and to lift API rate limits), provide a GitHub
token. Resolution order: `GITHUB_TOKEN` → `GH_TOKEN` → the `gh` CLI.

**The cleanest way is the `gh` CLI** — no token to manage, just the familiar
browser-confirm flow:

```bash
gh auth login        # browser confirmation; quiver picks up the token automatically
```

Once `gh` is authenticated, quiver uses its token automatically. For CI or
environments without `gh`, set `GITHUB_TOKEN` (or `GH_TOKEN`) instead:

```bash
GITHUB_TOKEN=ghp_… quiver-cli add mcp:context7
```

The token needs read access to the catalog repo. quiver never writes tokens to
generated configs or the lockfile.

## Secrets

MCP servers referencing `${VAR}` placeholders resolve from `.env.local` at the
repo root (gitignored). `init`/`add` generate an `.env.local.example` listing
exactly the variables the selected servers need (none needed → no file). For
Codex, secret headers are mapped to `env_http_headers` so secrets never land in
the committed `config.toml`.

## Staying up to date

quiver-cli checks npm for a newer release (at most once a day, cached under
`~/.cache/quiver/`) and prints a one-line notice after a command when an update
is available. `quiver-cli version` checks on demand. Update with:

```bash
pnpm add -g quiver-cli   # or: npm i -g quiver-cli / yarn global add quiver-cli
```

The check is best-effort and never blocks or fails a command. It is silenced
automatically for `--json`, non-interactive shells and CI, and can be disabled
entirely with `QUIVER_NO_UPDATE_NOTIFIER=1`.

## Development

```bash
pnpm install
pnpm build          # tsup -> dist/cli.js
pnpm typecheck
pnpm test           # vitest
```

The catalog lives under `template/.agents/`. Edit it to change what's available
to install.
