# Shared Agent Setup

This directory is the **single source of truth** for all AI agent configuration
in this repository. Tool-specific discovery files (`.claude/settings.json`,
`.claude/skills/`, `.claude/commands/`, `.opencode/skills/`, `.opencode/commands/`,
`.mcp.json`, `tui.json`, `AGENTS.md`, `CLAUDE.md`, `OPENCODE.md`) are generated
from the canonical files here.

## Directory Structure

```
.agents/
├── AGENTS.md            # Canonical root agent guide (symlinked from repo root)
├── config.json          # Shared config: MCP servers, permissions, TUI theme
├── design-context.md    # UI/UX design guidelines (symlinked as OPENCODE.md)
├── README.md            # This file
├── commands/            # Slash commands (symlinked to .claude/ and .opencode/)
│   ├── cp.md            # /cp — Commit and push with Conventional Commits
│   ├── deploy-check.md  # /deploy-check — Pre-release audit
│   ├── next-setup.md    # /next-setup — Scaffold Next.js project
│   ├── pr-check.md      # /pr-check — Run full CI pipeline locally
│   ├── review.md        # /review — Code review against conventions
│   └── tf-readme.md     # /tf-readme — Terraform README audit
└── skills/              # Background knowledge (symlinked to .claude/ and .opencode/)
    ├── design/          # UI/UX design skills
    │   └── impeccable/      # Production-grade frontend design + iteration
    │                        #   (/impeccable craft|shape|audit|critique|polish|
    │                        #   bolder|quieter|distill|harden|onboard|animate|
    │                        #   colorize|typeset|layout|delight|overdrive|clarify|
    │                        #   adapt|optimize|init|document|extract|live)
    ├── code/            # Code quality skills
    │   ├── build-debug/     # Debug failed CI/CD runs
    │   ├── cleanup/         # Find unused code (knip)
    │   └── code-quality-auditor/ # Maintainability hotspot audit (+ references)
    ├── repo/            # Repository setup skills
    │   ├── repo-ci/         # GitHub repo + CI setup
    │   ├── repo-init-next-js/ # Scaffold Next.js project (+ references, scripts)
    │   └── repo-init-node/  # Scaffold Node.js project
    ├── langfuse/        # Langfuse observability: CLI, instrumentation,
    │                    #   prompt migration, judge calibration (+ references)
    ├── posthog/         # PostHog for Next.js: analytics, LLM analytics,
    │                    #   error tracking, feature flags (+ references)
    ├── find-skills/     # Discover and install agent skills (npx skills)
    ├── agent-browser/   # Browser automation CLI for AI agents (Vercel)
    ├── skill-creator/   # Create, improve, and eval skills (Anthropic)
    │                    #   (+ agents, scripts, eval-viewer, references)
    └── db-query/        # Ad-hoc Prisma queries
```

## How It Works

1. **`.agents/`** contains all canonical agent guidance, commands, and config
2. Root `AGENTS.md`, `CLAUDE.md`, and `OPENCODE.md` are symlinks for provider discovery
3. `config.json` drives generation of `.claude/settings.json`, `.mcp.json`, and `tui.json`
4. Skills are symlinked into `.claude/skills/` and `.opencode/skills/`
5. Commands are symlinked into `.claude/commands/` and `.opencode/commands/`
6. Running `pnpm agents:sync` regenerates all shims
7. Running `pnpm agents:check` verifies shims are up to date

## Commands vs Skills

|                | Commands (`/cp`)             | Skills                                      |
| -------------- | ---------------------------- | ------------------------------------------- |
| **Invocation** | Explicit by user via `/name` | Loaded automatically by agent when relevant |
| **Purpose**    | Step-by-step workflows       | Background knowledge and conventions        |
| **Claude**     | `.claude/commands/*.md`      | `.claude/skills/*/SKILL.md`                 |
| **OpenCode**   | `.opencode/commands/*.md`    | `.opencode/skills/*/SKILL.md`               |

## Workflows

### Add a new slash command

1. Create a `.md` file in `.agents/commands/`:
   ```bash
   touch .agents/commands/my-command.md
   ```
2. Write the command content (use existing commands as reference)
3. Run sync:
   ```bash
   pnpm agents:sync
   ```
4. Verify: the command is now available as `/my-command` in both Claude Code
   and OpenCode via symlinks in `.claude/commands/` and `.opencode/commands/`

### Add a new skill

1. Create a directory with a `SKILL.md` under `.agents/skills/`:
   ```bash
   mkdir .agents/skills/my-skill
   touch .agents/skills/my-skill/SKILL.md
   ```
2. Write the skill content. Optionally add `references/` for detailed docs
   or `scripts/` for validation helpers
3. Run sync:
   ```bash
   pnpm agents:sync
   ```
4. Verify: the skill is now available in both Claude Code and OpenCode

### Edit an existing command or skill

1. Edit the file directly under `.agents/commands/` or `.agents/skills/`
2. No sync needed -- symlinks point to the canonical files, so changes take
   effect immediately

### Change MCP servers or permissions

1. Edit `.agents/config.json`
2. Run sync to regenerate provider configs:
   ```bash
   pnpm agents:sync
   ```
3. Restart your AI tool to pick up the new config

### Remove a command or skill

1. Delete the file or directory under `.agents/commands/` or `.agents/skills/`
2. Run sync -- stale symlinks are cleaned up automatically:
   ```bash
   pnpm agents:sync
   ```

## What is committed vs generated

| Path                          | Status        | Notes                                       |
| ----------------------------- | ------------- | ------------------------------------------- |
| `.agents/**`                  | **Committed** | Source of truth for all agent config        |
| `AGENTS.md`                   | **Committed** | Symlink to `.agents/AGENTS.md`              |
| `CLAUDE.md`                   | **Committed** | Symlink to `AGENTS.md`                      |
| `OPENCODE.md`                 | **Committed** | Symlink to `.agents/design-context.md`      |
| `.claude/settings.json`       | **Generated** | From `config.json`, gitignored              |
| `.claude/settings.local.json` | **Manual**    | Local overrides, gitignored                 |
| `.claude/commands/`           | **Generated** | Symlinks to `.agents/commands/`, gitignored |
| `.claude/skills/`             | **Generated** | Symlinks to `.agents/skills/`, gitignored   |
| `.opencode/commands/`         | **Generated** | Symlinks to `.agents/commands/`, gitignored |
| `.opencode/skills/`           | **Generated** | Symlinks to `.agents/skills/`, gitignored   |
| `.mcp.json`                   | **Generated** | From `config.json`, gitignored              |
| `tui.json`                    | **Generated** | From `config.json`, gitignored              |

## Maintenance

- Always edit under `.agents/`, never in `.claude/` or `.opencode/` (generated
  outputs are symlinks and will be overwritten)
- After changing `config.json`, adding/removing skills or commands, run:
  ```bash
  pnpm agents:sync && pnpm agents:check
  ```
- The sync runs automatically on `pnpm install` via the postinstall hook
- The sync script lives at `scripts/agents/sync-agent-shims.mjs`
