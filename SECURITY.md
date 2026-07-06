# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately. Do **not** open a public
issue for security-sensitive reports.

Use GitHub's [private vulnerability reporting](https://github.com/nbialk/quiver-cli/security/advisories/new)
("Report a vulnerability" under the repository's Security tab). We will
acknowledge your report and work with you on a fix and coordinated disclosure.

## Scope and handling of secrets

quiver-cli handles a few security-relevant concerns; please keep these in mind
when reporting:

- **GitHub tokens** — tokens for private (`github:`) catalogs are read from
  `GITHUB_TOKEN`/`GH_TOKEN` or the `gh` CLI. quiver never persists tokens
  itself, and never writes them to generated configs or the lockfile.
- **MCP secrets** — `${VAR}` placeholders in MCP server configs resolve from
  `.env.local` (gitignored). For Codex, secret headers are mapped to
  `env_http_headers` so secrets stay out of the committed `config.toml`.
- **Tool-description poisoning** — `quiver-cli check` re-introspects MCP servers
  and diffs tool descriptions and input schemas against the lockfile snapshot to
  surface malicious changes. stdio servers run foreign code and are only
  introspected with `--introspect-stdio`.

## Supported versions

Security fixes are applied to the latest released version on npm.
