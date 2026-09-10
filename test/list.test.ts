import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parse } from "../src/cli.js";
import { treeDigest } from "../src/catalog/digest.js";
import { list } from "../src/commands/list.js";
import { emptyLockfile, writeLockfile } from "../src/lockfile/io.js";
import type { EntrySource, Lockfile } from "../src/lockfile/schema.js";
import * as ui from "../src/ui/prompts.js";

describe("list", () => {
  let dir: string;
  let lock: Lockfile;
  const exitCode = process.exitCode;
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
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
    if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
    else Reflect.deleteProperty(process.stdout, "columns");
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const invoke = (json = false, verbose = false) => list({ ...parse(["list", ...(json ? ["--json"] : []), ...(verbose ? ["--verbose"] : [])]).options, targetRoot: dir });

  it.each([false, true])("refreshes cached metadata only for matching installed content (drift: %s)", async (drift) => {
    const skillDir = join(dir, ".agents/skills/demo");
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");
    writeFileSync(file, "---\nname: demo\ndescription: >-\n  Useful skill\n  description\nmetadata:\n  version: '1.9.4'\n---\nInstructions\n");
    const entry = lock.entries["skill:demo"]!;
    if (entry.type !== "skill") throw new Error("Expected skill");
    entry.digest = treeDigest(skillDir);
    entry.frontmatter = { name: "demo", description: ">-", version: null };
    writeLockfile(dir, lock);
    const before = readFileSync(join(dir, "quiver.lock"), "utf8");
    if (drift) writeFileSync(file, "---\nname: demo\nversion: 99\n---\nChanged\n");

    await invoke(true);
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
    expect(output.skills[0]).toMatchObject({
      version: drift ? null : "1.9.4",
      description: drift ? ">-" : "Useful skill description",
      source: github,
    });
    expect(readFileSync(join(dir, "quiver.lock"), "utf8")).toBe(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

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
    await invoke(false, true);
    const output = vi.mocked(ui.block).mock.calls[0]![0].join("\n");
    expect(output).toContain(`github:acme/skills/skills/demo#stable @ ${"b".repeat(12)}`);
    expect(output).toContain("legacy (unverified): github:old/catalog, path commands/review.md");
    expect(output).toContain("local: /local/catalog/plugins/local.ts");
    expect(output).toContain("disabled");
    expect(output).toContain("1 tool");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows compact sections without source details or healthy dependency diagnostics", async () => {
    await invoke();
    const output = vi.mocked(ui.block).mock.calls[0]![0].join("\n");
    for (const heading of ["Skills · 1", "Commands · 1", "MCP · 1", "Plugins · 1", "Provider: claude"]) {
      expect(output).toContain(heading);
    }
    expect(output).toContain("2.0.0");
    expect(output).toContain("✓");
    expect(output).toContain("disabled");
    expect(output).not.toContain("github:");
    expect(output).not.toContain("https://docs.example");
    expect(output).not.toContain("dependency node:");
  });

  it.each([40, 200])("limits descriptions to terminal width and 55 characters (%s columns)", async (columns) => {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
    const entry = lock.entries["skill:demo"]!;
    if (entry.type !== "skill") throw new Error("Expected skill");
    entry.frontmatter.description = "x".repeat(100);
    entry.frontmatter.version = null;
    writeLockfile(dir, lock);
    await invoke();
    const row = vi.mocked(ui.block).mock.calls[0]![0].find((line) => line.includes("demo"))!;
    const plain = row.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("—");
    expect(plain).toContain("…");
    expect(plain.length).toBeLessThanOrEqual(columns);
    expect(plain.match(/x+…/)![0].length).toBeLessThanOrEqual(55);
  });

  it("keeps dependency problems visible in compact output", async () => {
    const entry = lock.entries["plugin:local"]!;
    if (entry.type !== "plugin") throw new Error("Expected plugin");
    entry.requires = ["quiver-nonexistent-test-binary"];
    writeLockfile(dir, lock);
    await invoke();
    const output = vi.mocked(ui.block).mock.calls[0]![0].join("\n");
    expect(output).toContain("dependency quiver-nonexistent-test-binary: missing");
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
