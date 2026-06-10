# quiver-cli

Compose a selected subset of skills, slash commands and MCP servers from a
central catalog into any repo — as **native configs** for opencode, Claude Code
and Codex — with **lockfile-based drift awareness**.

One thing done right: repo composition + drift detection. No marketplace, no
extra agents, no command abstraction.

## Install into a repo

From the root of the target repository:

```bash
pnpm dlx quiver-cli init
```

This will:

1. Let you pick skills, commands and MCP servers from the catalog (interactive).
2. Materialize the selected artifacts into the repo's `.agents/` (committed).
3. Generate native provider configs and write `quiver.lock`.
4. Add generated shims + `.env.local` to `.gitignore`.

`.agents/` and `quiver.lock` are the source of truth and should be committed.
The generated provider files are not.

## Commands

| Command                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `quiver-cli init`        | Interactive picker; write native configs + `quiver.lock`          |
| `quiver-cli add <id>`    | Add one entry (`skill:<name>`, `command:<name>`, `mcp:<name>`)    |
| `quiver-cli remove <id>` | Remove one entry; keep lockfile + configs consistent              |
| `quiver-cli sync`        | Regenerate provider shims from `.agents/`; warn on drift          |
| `quiver-cli status`      | Diff the lockfile against what is actually in the repo (exit 1)   |
| `quiver-cli check`       | Detect upstream drift (skill digests, MCP tool snapshots)         |
| `quiver-cli upstream`    | Check source repos for skill updates (catalog maintenance)        |
| `quiver-cli help`        | Show help                                                         |

Options: `-f/--force`, `--all/-y` (non-interactive), `--json`
(status/check/upstream), `--introspect-stdio` (allow running stdio MCP servers
during `check`).

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

## The lockfile

`quiver.lock` records, per entry: source path, content digest, and — for MCP
servers — a **tool snapshot** (`{ description, inputSchemaHash }` per tool).
This is the basis for `status`, `sync` and `check`.

## `check` — drift awareness

- **Skills/commands**: compares the stored digest against the current `.agents/`
  content.
- **MCP servers** (the real lever): re-introspects `tools/list` and diffs against
  the snapshot → new/removed tools, changed input schemas, and — security
  critical — **changed tool descriptions** (defends against tool-description
  poisoning), shown as a readable before/after.

The first successful introspection records a baseline; subsequent `check` runs
diff against it. Servers that fail introspection (e.g. requiring interactive
OAuth) are reported as skipped. stdio servers run foreign code and are only
introspected with `--introspect-stdio`.

`quiver-cli check --json` is CI-friendly (exit 1 on drift).

## `upstream` — source updates

`check` detects drift between the lockfile and the repo's `.agents/`. `upstream`
answers a different question: **has the source repo updated a skill since it was
imported into the catalog?**

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

Updating is manual: re-fetch with the skills CLI (`pnpm dlx skills add <repo>`),
copy into the catalog, then `quiver-cli upstream` again to record the new
baseline. `quiver-cli upstream --json` is CI-friendly (exit 1 on drift).

## Secrets

MCP servers referencing `${VAR}` placeholders resolve from `.env.local` at the
repo root (gitignored). `init`/`add` generate an `.env.local.example` listing
exactly the variables the selected servers need (none needed → no file). For
Codex, secret headers are mapped to `env_http_headers` so secrets never land in
the committed `config.toml`.

## Development

```bash
pnpm install
pnpm build          # tsup -> dist/cli.js
pnpm typecheck
pnpm test           # vitest
```

The catalog lives under `template/.agents/`. Edit it to change what's available
to install.
