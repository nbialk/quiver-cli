import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parse } from "../src/cli.js";
import { list } from "../src/commands/list.js";
import { emptyLockfile, writeLockfile } from "../src/lockfile/io.js";
import type { EntrySource, Lockfile } from "../src/lockfile/schema.js";
import * as ui from "../src/ui/prompts.js";

describe("list", () => {
  let dir: string;
  let lock: Lockfile;
  const exitCode = process.exitCode;
  const digest = `sha256:${"a".repeat(64)}`;
  const github: EntrySource = {
    kind: "github", repo: "acme/skills", path: "skills/demo", ref: "stable",
    commit: "b".repeat(40), digest,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quiver-list-"));
    lock = emptyLockfile("github:old/catalog");
    lock.providers = ["claude"];
    lock.entries = {
      "skill:demo": {
        type: "skill", installedPath: "skills/demo", source: github, digest,
        frontmatter: { name: "demo", description: "Demo skill", version: "2.0.0" },
      },
      "command:review": {
        type: "command", installedPath: "commands/review.md", digest,
        source: { kind: "legacy", catalog: lock.catalog, sourcePath: "commands/review.md" },
      },
      "mcp:docs": {
        type: "mcp", source: { ...github, path: "config.json" }, transport: "http",
        configDigest: digest, toolsFetchedAt: "2026-09-08T00:00:00.000Z",
        tools: { search: { description: "Search docs", inputSchemaHash: digest, tokens: 42 } },
      },
      "plugin:local": {
        type: "plugin", provider: "opencode", installedPath: "plugins/local.ts", digest,
        source: { kind: "local", root: "/local/catalog", path: "plugins/local.ts", digest },
        requires: ["node"],
      },
    };
    mkdirSync(join(dir, ".agents"));
    writeFileSync(join(dir, ".agents/config.json"), JSON.stringify({
      mcpServers: { docs: { transport: "http", url: "https://docs.example/mcp" } },
    }));
    writeFileSync(join(dir, ".agents/config.local.json"), JSON.stringify({ mcpServers: { docs: { enabled: false } } }));
    writeLockfile(dir, lock);
    process.exitCode = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(ui, "block").mockImplementation(() => {});
    vi.spyOn(ui, "error").mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const invoke = (json = false) => list({ ...parse(["list", ...(json ? ["--json"] : [])]).options, targetRoot: dir });

  it("includes full provenance for every JSON entry and retains MCP costs and overrides", async () => {
    await invoke(true);
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
    expect(output.ok).toBe(true);
    expect(output.skills[0]).toMatchObject({ name: "demo", source: github, version: "2.0.0" });
    expect(output.commands[0].source).toEqual(lock.entries["command:review"]!.source);
    expect(output.plugins[0]).toMatchObject({ source: lock.entries["plugin:local"]!.source, requires: ["node"] });
    expect(output.mcp[0]).toMatchObject({
      source: lock.entries["mcp:docs"]!.source, enabled: false,
      toolCount: 1, tokenEstimate: 42, detail: "https://docs.example/mcp",
    });
    expect(ui.block).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows repo, path, ref, short commit, local origins, and unverified legacy origins", async () => {
    await invoke();
    const output = vi.mocked(ui.block).mock.calls[0]![0].join("\n");
    expect(output).toContain(`github:acme/skills/skills/demo#stable @ ${"b".repeat(12)}`);
    expect(output).toContain("legacy (unverified): github:old/catalog, path commands/review.md");
    expect(output).toContain("local: /local/catalog/plugins/local.ts");
    expect(output).toContain("disabled");
    expect(output).toContain("1 tools");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("marks normalized V1 entries as legacy without inferring current provenance", async () => {
    writeFileSync(join(dir, "quiver.lock"), JSON.stringify({
      version: 1, catalog: lock.catalog,
      entries: { "command:old": { type: "command", sourcePath: "commands/old.md", digest } },
    }));
    await invoke(true);
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
    expect(output.commands).toEqual([{
      name: "old", source: { kind: "legacy", catalog: lock.catalog, sourcePath: "commands/old.md" },
    }]);
  });

  it("returns one structured error when no lockfile exists", async () => {
    rmSync(join(dir, "quiver.lock"));
    await invoke(true);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
      ok: false, error: { code: "no-lockfile", message: expect.any(String) },
    });
    expect(process.exitCode).toBe(2);
    expect(ui.error).not.toHaveBeenCalled();
  });
});
