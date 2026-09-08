# Security Policy

## Reporting A Vulnerability

Please report security vulnerabilities privately. Do **not** open a public
issue for security-sensitive reports.

Use GitHub's [private vulnerability reporting](https://github.com/nbialk/quiver-cli/security/advisories/new)
("Report a vulnerability" under the repository's Security tab). We will
acknowledge your report and work with you on a fix and coordinated disclosure.

## Source Trust

V2 installs direct GitHub skills and custom catalog assets into committed local
`.agents/` content. The public default catalog is maintained in
[quiver-catalog](https://github.com/nbialk/quiver-catalog), not bundled with the
CLI. A catalog listing, commit pin or matching digest is not a security review.

- Review skill instructions, scripts, commands, plugins and MCP definitions
  before enabling them. Quiver does not execute direct skill scripts, but a
  provider agent may execute installed code with your permissions.
- Installed entries pin their own source, requested ref, commit and pristine
  digest. Catalog pointer changes affect new installs only. `--force` permits
  discarding local edits; it does not authorize retargeting a source.
- Missing refs, authentication failures, invalid downloads and unavailable
  sources are errors, not evidence of up-to-date content.
- A selected skill cannot contain symlinks. Digests cover file content and
  relative paths, not file modes. GitHub is the only remote host; LFS objects
  and submodules are not hydrated.
- V1 migration preserves legacy provenance as unverified. It does not establish
  that old bundled or curated content came unchanged from an original author.

## Baselines And Execution

Normal `check` is project-read-only. Explicit `check <id> --accept` or
`check --all --accept` records reviewed local baselines and successfully observed
MCP snapshots, never new pristine source digests. Accepted customizations remain
protected from later updates without destructive approval.

MCP snapshots expose changed descriptions and input schemas, including possible
tool-description poisoning; they do not prevent a malicious server from acting
or prove that an initial snapshot was safe. Missing, skipped or authentication-
blocked observations remain incomplete rather than certifying current tools.
Stdio introspection executes foreign code and requires `--introspect-stdio`.
`check --offline` skips live introspection, accesses no network and executes no
stdio MCP server. `init --empty` and `sync` also need no source network access.

Installation uses per-entry staging and rollback for handled I/O failures, not
a global or crash-atomic transaction. Successful entries remain locked after
partial failures. Recovery directories `.quiver-stage-*` can contain previous
local content; keep them private and review retained backups before deleting
them. Repair generated provider output with `sync`.

## Secrets

- GitHub credentials are read from `GITHUB_TOKEN`, `GH_TOKEN` or the authenticated
  `gh` CLI. Quiver does not persist these tokens or write them to the lockfile or
  generated provider configuration. Use tokens scoped to required read access.
- MCP `${VAR}` placeholders resolve from `.env.local`. OpenCode output uses
  `{env:VAR}` references; Codex secret headers use `env_http_headers`. Do not put
  literal credentials in committed `.agents/config.json`.
- Keep `.env.local`, local overrides and generated provider files gitignored.
  Commit the installed `.agents/` source and `quiver.lock`, not secrets.
- OAuth introspection may read OpenCode's existing credentials. Quiver neither
  refreshes nor rewrites that credential store.
- Download caches may contain private source content. Protect the cache under
  `~/.cache/quiver/` or `$XDG_CACHE_HOME/quiver/`, including in shared CI runners.
  An update dry run may populate this cache while leaving the project unchanged.

## Supported Versions

Security fixes are applied to the latest released version on npm.
