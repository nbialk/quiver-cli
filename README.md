# nb-agents

Portable AI agent configuration. Hosts a single canonical `.agents/` directory
(skills, slash commands, MCP servers, permissions, agent guides) and installs it
into any repository with one command. Generates provider shims for Claude Code
and OpenCode.

## Install into a repo

From the root of the target repository:

```bash
npx github:nbialk/nb-agents init
```

This will:

1. Copy `.agents/` (skills, commands, config) into the repo.
2. Copy `scripts/agents/sync-agent-shims.mjs`.
3. Prompt which skills to keep (interactive; skipped when not a TTY).
4. Prompt which MCP servers to keep (interactive; skipped when not a TTY).
5. Wire `agents:sync`, `agents:check`, and `postinstall` into `package.json`.
6. Add generated provider paths to `.gitignore`.
7. Run an initial sync to create the `.claude/` and `.opencode/` shims.

Use `--force` to overwrite existing `.agents/` / script files.

### Selecting skills

During `init` you pick which skills to install via a grouped checkbox list.
`find-skills` and `skill-creator` are preselected; everything else starts off:

```
◆  Select skills to install (space toggles, a all, enter confirms)
│  (general)
│  ◼ find-skills
│  ◼ skill-creator
│  ◻ agent-browser
│  ◻ db-query
│  (code)
│  ◻ cleanup
│  (design)
│  ◻ impeccable
└
```

Deselected skill directories are **deleted** from the copied `.agents/skills/`
(empty group folders are cleaned up too).

### Selecting MCP servers

Next you pick MCP servers, grouped by transport (remote first, then local),
all preselected:

```
◆  Select MCP servers (space toggles, a all, enter confirms)
│  (remote)
│  ◼ langfuse-docs https://langfuse.com/api/mcp
│  ◼ context7      https://mcp.context7.com/mcp
│  (local)
│  ◼ playwright    npx -y @playwright/mcp@latest --isolated
└
```

Deselected servers are stripped from the copied `.agents/config.json`.

### Both prompts

- **↑ / ↓** move, **space** toggles, **a** toggles all, **enter** confirms.
- **Ctrl+C** cancels with no changes.
- Pass `--all` (or `-y`) to keep everything without prompting, e.g. in CI. The
  prompts are skipped automatically when stdin is not a TTY.
- You can always re-edit afterward and re-run `npx nb-agents sync`.

> Requires Node >= 20.12. The interactive UI uses `@clack/prompts`; if it can't
> load, `init` falls back to a plain numbered text prompt.

### Secrets (`.env.local`)

Some MCP servers need a secret, referenced in `.agents/config.json` as
`${VAR_NAME}`. The single, central place for these is **`.env.local` in your repo
root**. The sync script reads it and interpolates the values into the generated
`.mcp.json` / `opencode.json`.

`init` drops a `.env.local.example` at the repo root and adds `.env.local` to
`.gitignore`. To set up secrets:

```bash
cp .env.local.example .env.local   # then fill in the values you need
npx nb-agents sync                 # regenerate with secrets interpolated
```

Currently only two servers need a secret:

- `NEON_API_KEY` — Neon personal API key
- `LANGFUSE_MCP_TOKEN` — base64 of `pk-lf-…:sk-lf-…` (`echo -n "pk-lf-…:sk-lf-…" | base64`)

The rest authenticate via OAuth on first use (`vercel`, `notion`, `posthog`) or
need nothing (`playwright`, `langfuse-docs`, `context7`). Never commit
`.env.local`; the generated `.mcp.json` already contains the resolved secrets and
is gitignored too.

## Commands

| Command                    | Description                                              |
| -------------------------- | -------------------------------------------------------- |
| `npx nb-agents init`       | Full setup (copy + select skills & MCP + wire + sync)    |
| `npx nb-agents sync`       | Regenerate provider shims                                |
| `npx nb-agents check`      | Verify shims are up to date (exit 1 if not, for CI)      |
| `npx nb-agents update`     | Re-copy `.agents/` + script only (keeps package.json)    |
| `npx nb-agents help`       | Show help                                                |

After install you can also use the wired scripts: `pnpm agents:sync`,
`pnpm agents:check` (or `npm run` / `yarn`).

## What gets installed

```
.agents/                    # canonical source of truth (committed)
├── AGENTS.md               # root agent guide — EDIT per project
├── config.json             # MCP servers, permissions, TUI theme
├── design-context.md       # UI/UX guidelines — EDIT per project
├── commands/               # slash commands
└── skills/                 # skills, nested in groups (design/, code/, repo/, …)
scripts/agents/
└── sync-agent-shims.mjs    # generates provider shims from .agents/
.env.local.example          # secrets template — copy to .env.local, then fill in
```

Generated (gitignored): `.claude/`, `.opencode/`, `.mcp.json`, `opencode.json`,
`tui.json`, `.env.local`.

## Per-project customization

The template ships a full skill/command set. The `init` prompts let you pick
skills and MCP servers up front; you can refine further afterward:

- **`.agents/AGENTS.md`** — replace stack/structure details with the new repo's.
- **`.agents/design-context.md`** — adjust design guidelines.
- **`.agents/config.json`** — remove MCP servers you don't need; secrets stay as
  `${ENV_VAR}` placeholders resolved from `.env.local` (see [Secrets](#secrets-envlocal)).
- Delete (or re-add) skill directories under `.agents/skills/`.

Then run `npx nb-agents sync` (or `pnpm agents:sync`).

## Updating the canonical config

Edit files under `template/.agents/` in this repo. Bump the version, push, and in
target repos run `npx github:Snickers03/nb-agents@latest update`.

## How sync works

`sync-agent-shims.mjs` reads `.agents/config.json` and the `.agents/skills` /
`.agents/commands` trees, then:

- Writes `.claude/settings.json`, `.mcp.json`, `opencode.json` from config.
- Symlinks each skill (discovered recursively, any nesting depth) into
  `.claude/skills/` and `.opencode/skills/` by leaf name.
- Symlinks each command into `.claude/commands/` and `.opencode/commands/`.
- Removes stale shims that no longer have a source.
