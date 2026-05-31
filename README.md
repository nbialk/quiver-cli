# nb-agents

Portable AI agent configuration. Hosts a single canonical `.agents/` directory
(skills, slash commands, MCP servers, permissions, agent guides) and installs it
into any repository with one command. Generates provider shims for Claude Code
and OpenCode.

## Install into a repo

From the root of the target repository:

```bash
npx github:Snickers03/nb-agents init
```

This will:

1. Copy `.agents/` (skills, commands, config) into the repo.
2. Copy `scripts/agents/sync-agent-shims.mjs`.
3. Wire `agents:sync`, `agents:check`, and `postinstall` into `package.json`.
4. Add generated provider paths to `.gitignore`.
5. Run an initial sync to create the `.claude/` and `.opencode/` shims.

Use `--force` to overwrite existing `.agents/` / script files.

## Commands

| Command                    | Description                                              |
| -------------------------- | -------------------------------------------------------- |
| `npx nb-agents init`       | Full setup (copy + wire + sync)                          |
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
```

Generated (gitignored): `.claude/`, `.opencode/`, `.mcp.json`, `opencode.json`,
`tui.json`.

## Per-project customization

The template ships a full skill/command set ("install everything, prune later").
After `init`, adapt these to the new project:

- **`.agents/AGENTS.md`** — replace stack/structure details with the new repo's.
- **`.agents/design-context.md`** — adjust design guidelines.
- **`.agents/config.json`** — remove MCP servers you don't need; secrets stay as
  `${ENV_VAR}` placeholders and require a `.env.local` in the target repo.
- Delete unneeded skill directories under `.agents/skills/`.

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
