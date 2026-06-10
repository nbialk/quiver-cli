# AGENTS.md

Guide for coding agents working in this repository.

## Agent Setup

Agent configuration (skills, commands, MCP servers) lives in `.agents/` — the
single source of truth, managed by [quiver-cli](https://github.com/nbialk/quiver-cli):

- `.agents/skills/` — agent skills (SKILL.md directories).
- `.agents/commands/` — slash commands.
- `.agents/config.json` — MCP servers and shared settings.
- `quiver.lock` — locked state with content digests.

Provider files (`.claude/`, `.opencode/`, `.codex/`, `.mcp.json`,
`opencode.json`) are **generated** from `.agents/` and gitignored. Do not edit
them directly.

## Workflow

- `quiver-cli sync` — regenerate provider configs from `.agents/`.
- `quiver-cli status` — verify lockfile and shims are in sync.
- `quiver-cli add/remove <id>` — change what is installed.
- Commit `.agents/` and `quiver.lock`; never commit generated provider files
  or `.env.local`.
