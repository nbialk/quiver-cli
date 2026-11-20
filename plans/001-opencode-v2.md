# OpenCode V2 compatibility

Planned at `d9a5a6c`. No prerequisite changes.

1. Inspect the OpenCode 2.3.2 public MCP endpoint contract. On rejected direct HTTP introspection, distinguish an already connected matching project/server from a missing login. Use full tool schemas only if available and verifiably from the intended server. If only status is available, report the snapshot as incomplete without replacing its baseline or asking a connected user to sign in. Preserve offline, disabled, stdio opt-in, and V1 behavior. Keep subprocess calls bounded and noninteractive; avoid initializing arbitrary project plugins/stdio servers without opt-in.
2. In the OpenCode provider/write path, retain V1 TUI output and marker-based cleanup for compatibility, but explain at sync time that V2 uses global CLI settings. Do not change global files. Keep existing MCP output compatible with both versions.
3. Update affected README/help messages and tests. Add a pinned OpenCode 2.3.2 CI smoke test in an isolated fixture that exercises actual generated output and V2 plugin discovery. Keep test data local, no accounts or production secrets.
4. Verify `pnpm typecheck`, `pnpm test`, `pnpm build`, and the smoke test. Scope: MCP/check/reporting, provider writing, README, associated tests and CI only. No dependency upgrade sweep. Stop if implementing a real tool snapshot requires private credential storage; use the documented incomplete-status alternative instead.
