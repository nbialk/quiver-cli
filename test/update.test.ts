import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { jsonDigest, treeDigest } from "../src/catalog/digest.js";
import { loadCatalog } from "../src/catalog/discover.js";
import { resolveCatalog } from "../src/catalog/resolve.js";
import { check } from "../src/commands/check.js";
import { installPreparedEntry } from "../src/commands/install.js";
import { migrate } from "../src/commands/migrate.js";
import { sync } from "../src/commands/sync.js";
import { update } from "../src/commands/update.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";
import { prepareCatalogEntry, prepareDirectSkill, type PreparedEntry } from "../src/sources/entry.js";
import { parseGithubSource, resolveGithubDirectory, type ResolvedGithubDirectory } from "../src/sources/github.js";
import * as ui from "../src/ui/prompts.js";

vi.mock("../src/sources/github.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/sources/github.js")>(),
  resolveGithubDirectory: vi.fn(),
}));
vi.mock("../src/catalog/resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/catalog/resolve.js")>(),
  resolveCatalog: vi.fn(() => { throw new Error("Discovery catalog is unavailable"); }),
}));

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const REMOTE = "github:acme/skills/Skills/Upstream#main";
const skill = (body: string): string =>
  `---\nname: demo\ndescription: A demo skill\n---\n${body}\n`;

let root: string;
let repoDir: string;
let catalogDir: string;
const remoteSources = new Map<string, ResolvedGithubDirectory>();

const write = (base: string, path: string, content: string | Buffer): void => {
  fs.mkdirSync(dirname(join(base, path)), { recursive: true });
  fs.writeFileSync(join(base, path), content);
};

// Include hidden files, binary bytes, empty directories and link targets without following links.
const snapshot = (base: string): Record<string, string> => {
  const entries: Record<string, string> = {};
  const walk = (path: string): void => {
    const full = join(base, path);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) entries[path] = `link:${fs.readlinkSync(full)}`;
    else if (stat.isDirectory()) {
      entries[path] = "directory";
      for (const name of fs.readdirSync(full).sort()) walk(join(path, name));
    } else entries[path] = fs.readFileSync(full).toString("base64");
  };
  walk("");
  return entries;
};

const remote = (source: string, directory: string, commit = OLD_SHA): void => {
  remoteSources.set(source, {
    source, root: directory, ...parseGithubSource(source), resolved: commit,
    fetchedAt: "2026-09-08T00:00:00.000Z",
  });
};

const install = (prepared: PreparedEntry): void => {
  installPreparedEntry(repoDir, readLockfile(repoDir)!, prepared);
};

const setup = async () => {
  write(catalogDir, "skills/code/demo/SKILL.md", skill("v1"));
  write(catalogDir, "skills/code/demo/assets/data.bin", Buffer.from([0, 255, 42]));
  const source = { source: `local:${catalogDir}`, root: catalogDir };
  const prepared = await prepareCatalogEntry(source, loadCatalog(source), "skill:demo");
  install(prepared);
  if (prepared.entry.type !== "skill") throw new Error("Expected skill fixture");
  return {
    entry: prepared.entry,
    source: `local:${join(catalogDir, "skills/code/demo")}`,
    sourceFile: join(catalogDir, "skills/code/demo/SKILL.md"),
    skillPath: join(repoDir, ".agents/skills/demo/SKILL.md"),
  };
};

const setupRemote = async (source = REMOTE, name = "demo") => {
  const directory = join(root, "upstream", name);
  write(directory, "SKILL.md", skill("v1"));
  remote(source, directory);
  install(await prepareDirectSkill(source, name));
  vi.mocked(resolveGithubDirectory).mockClear();
  return { directory, skillPath: join(repoDir, `.agents/skills/${name}/SKILL.md`) };
};

const setupMcp = async () => {
  const server = { transport: "http" as const, url: "https://search.example.test/mcp" };
  const config = {
    shared: { local: true }, opencode: { model: "local/model" },
    claude: { settings: { local: true } },
    mcpServers: { sibling: { transport: "stdio", command: "never-run-sibling" } },
    plugins: { sibling: { provider: "opencode", sourcePath: "plugins/sibling.ts" } },
  };
  write(repoDir, ".agents/plugins/sibling.ts", "export const local = true;\n");
  write(repoDir, ".agents/config.json", JSON.stringify(config, null, 4) + "\n");
  write(catalogDir, "config.json", JSON.stringify({ mcpServers: { search: server } }));
  const source = { source: `local:${catalogDir}`, root: catalogDir };
  const prepared = await prepareCatalogEntry(source, loadCatalog(source), "mcp:search");
  if (prepared.entry.type !== "mcp") throw new Error("Expected MCP fixture");
  prepared.entry.tools = { search: { description: "Search documents", inputSchemaHash: jsonDigest({ type: "object" }), tokens: 20 } };
  prepared.entry.toolsFetchedAt = "2026-01-01T00:00:00.000Z";
  prepared.entry.authRequired = true;
  install(prepared);
  return { entry: prepared.entry, server, config };
};

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "quiver-update-"));
  repoDir = join(root, "repo");
  catalogDir = join(root, "catalog");
  write(repoDir, ".agents/config.json", "{}\n");
  const lock = emptyLockfile("github:unavailable/discovery#main", { ref: "main", resolved: OLD_SHA });
  lock.providers = ["opencode"];
  writeLockfile(repoDir, lock);
  process.exitCode = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const name of ["success", "warn", "info", "error"] as const) vi.spyOn(ui, name).mockResolvedValue();
  vi.spyOn(ui, "block").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
  vi.mocked(resolveGithubDirectory).mockReset().mockImplementation(async (source) => {
    const resolved = remoteSources.get(source);
    if (!resolved) throw new Error(`Source unavailable: ${source}`);
    return resolved;
  });
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveCatalog).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
    remoteSources.clear();
    process.exitCode = 0;
  }
});

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  targetRoot: repoDir,
  force: false,
  all: false,
  json: true,
  verbose: false,
  accept: false,
  offline: false,
  dryRun: false,
  introspectStdio: false,
  providers: null,
  catalog: null,
  positionals: [],
  ...overrides,
});

interface UpdateReport {
  ok: boolean;
  dryRun: boolean;
  updated: string[];
  upToDate: string[];
  pinned: string[];
  localChanges: string[];
  legacy: string[];
  errors: string[];
  reports: { id: string; status: string; reason?: string; contentChanged?: boolean }[];
}

const run = async (overrides: Partial<CliOptions> = {}): Promise<UpdateReport> => {
  process.exitCode = 0;
  vi.mocked(console.log).mockClear();
  for (const render of [ui.block, ui.success, ui.warn, ui.info, ui.error]) vi.mocked(render).mockClear();
  await update(options(overrides));
  expect(console.log).toHaveBeenCalledExactlyOnceWith(expect.any(String));
  expect(console.error).not.toHaveBeenCalled();
  for (const render of [ui.block, ui.success, ui.warn, ui.info, ui.error]) expect(render).not.toHaveBeenCalled();
  return JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as UpdateReport;
};

describe("update integration", () => {
  it("dry-runs without changing any repository bytes, paths or provider links", async () => {
    const { sourceFile } = await setup();
    await setupMcp();
    write(repoDir, ".agents/AGENTS.md", "Local instructions\n");
    write(repoDir, ".agents/config.local.json", '{"mcpServers":{"search":{"enabled":false}}}\n');
    write(repoDir, ".env.local", "# Private local configuration\n");
    write(repoDir, ".gitignore", "node_modules/\n");
    write(repoDir, "src/app.ts", "export const untouched = true;\n");
    await sync(options());
    fs.writeFileSync(sourceFile, skill("v2"));
    write(catalogDir, "config.json", JSON.stringify({ mcpServers: {
      search: { transport: "http", url: "https://new.example.test/mcp", headers: { Authorization: "${UPDATE_TEST_TOKEN}" } },
    } }));
    const before = snapshot(repoDir);

    const report = await run({ dryRun: true });

    expect(report).toMatchObject({ ok: true, dryRun: true, updated: ["mcp:search", "skill:demo"], errors: [] });
    expect(snapshot(repoDir)).toEqual(before);
    expect(process.exitCode).toBe(0);
  });

  it("updates a pristine local source, retains its root/path, then leaves identical content alone", async () => {
    const { sourceFile, skillPath, entry } = await setup();
    const catalog = readLockfile(repoDir)!.catalog;
    fs.writeFileSync(sourceFile, skill("v2"));
    write(dirname(sourceFile), "references/new.md", "New resource\n");

    expect(await run()).toMatchObject({ ok: true, updated: ["skill:demo"], errors: [] });

    const digest = treeDigest(dirname(sourceFile));
    expect(fs.readFileSync(skillPath, "utf8")).toBe(skill("v2"));
    expect(treeDigest(dirname(skillPath))).toBe(digest);
    expect(readLockfile(repoDir)!.entries["skill:demo"]).toMatchObject({
      installedPath: entry.installedPath, digest, source: { ...entry.source, digest },
    });
    expect(readLockfile(repoDir)!.catalog).toEqual(catalog);
    expect(fs.readlinkSync(join(repoDir, ".opencode/skills/demo"))).toContain(".agents/skills/demo");
    const before = snapshot(repoDir);
    expect(await run()).toMatchObject({ ok: true, updated: [], upToDate: ["skill:demo"] });
    expect(snapshot(repoDir)).toEqual(before);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it.each(["before sync", "after sync", "after check --accept"])("preserves divergent local edits %s", async (phase) => {
    const { sourceFile, skillPath, entry } = await setup();
    fs.writeFileSync(skillPath, skill("local customization"));
    fs.writeFileSync(sourceFile, skill("v2"));
    if (phase !== "before sync") {
      await sync(options());
      expect(readLockfile(repoDir)!.entries["skill:demo"]).toEqual(entry);
    }
    if (phase === "after check --accept") {
      await check(options({ positionals: ["skill:demo"], accept: true, offline: true }));
      expect(process.exitCode).toBe(0);
      expect(readLockfile(repoDir)!.entries["skill:demo"]).toMatchObject({
        digest: treeDigest(dirname(skillPath)), source: entry.source,
      });
    }
    const before = snapshot(repoDir);

    expect(await run()).toMatchObject({ ok: false, updated: [], localChanges: ["skill:demo"], upToDate: [], errors: [] });
    expect(snapshot(repoDir)).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it("does not silently accept local edits when upstream independently converges to the same bytes", async () => {
    const { sourceFile, skillPath } = await setup();
    fs.writeFileSync(skillPath, skill("matching customization"));
    fs.writeFileSync(sourceFile, skill("matching customization"));
    const before = snapshot(repoDir);

    const report = await run();

    expect(report).toMatchObject({ ok: false, updated: [], upToDate: [], localChanges: ["skill:demo"] });
    expect(report.reports[0]).toMatchObject({ contentChanged: false });
    expect(snapshot(repoDir)).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it("requires force to restore the original source even when the candidate equals the source baseline", async () => {
    const { skillPath, entry } = await setup();
    fs.writeFileSync(skillPath, skill("accepted customization"));
    await sync(options());
    await check(options({ positionals: ["skill:demo"], accept: true, offline: true }));
    expect(process.exitCode).toBe(0);
    const before = snapshot(repoDir);

    expect(await run()).toMatchObject({ ok: false, updated: [], localChanges: ["skill:demo"] });
    expect(snapshot(repoDir)).toEqual(before);
    expect(await run({ force: true })).toMatchObject({ ok: true, updated: ["skill:demo"], localChanges: [] });
    expect(fs.readFileSync(skillPath, "utf8")).toBe(skill("v1"));
    expect(readLockfile(repoDir)!.entries["skill:demo"]).toEqual(entry);
    expect(process.exitCode).toBe(0);
  });

  it("reports a deleted SKILL.md as an error and never repairs it implicitly, even with force", async () => {
    const { sourceFile, skillPath } = await setup();
    fs.rmSync(skillPath);
    fs.writeFileSync(sourceFile, skill("v2"));
    const before = snapshot(repoDir);

    for (const force of [false, true]) {
      const report = await run({ force });
      expect(report).toMatchObject({ ok: false, updated: [], upToDate: [], pinned: [], errors: ["skill:demo"] });
      expect(report.reports[0]!.reason).toMatch(/SKILL\.md/);
      expect(snapshot(repoDir)).toEqual(before);
      expect(process.exitCode).toBe(2);
    }
  });

  it("reports an unavailable source once as an error, never as healthy or updated", async () => {
    await setupRemote();
    remoteSources.delete(REMOTE);
    const before = snapshot(repoDir);

    const report = await run();

    expect(report).toMatchObject({ ok: false, updated: [], upToDate: [], pinned: [], errors: ["skill:demo"] });
    expect(report.reports).toEqual([expect.objectContaining({ id: "skill:demo", status: "error", reason: `Source unavailable: ${REMOTE}` })]);
    expect(snapshot(repoDir)).toEqual(before);
    expect(process.exitCode).toBe(2);
  });

  it("retargets only the selected mixed-source alias without discovery or sibling pin changes", async () => {
    await setup();
    await setupRemote(REMOTE, "my-alias");
    const sibling = "github:other/skills/Sibling#Release/Stable";
    await setupRemote(sibling, "sibling");
    const before = readLockfile(repoDir)!;
    const siblingBytes = snapshot(join(repoDir, ".agents/skills/sibling"));
    const replacement = "github:new-owner/skills/NewName#Release/Next";
    const directory = join(root, "replacement");
    write(directory, "SKILL.md", skill("retargeted"));
    remote(replacement, directory, NEW_SHA);
    remoteSources.delete(REMOTE);
    remoteSources.delete(sibling);

    expect(await run({ positionals: ["my-alias"], source: replacement })).toMatchObject({ ok: true, updated: ["skill:my-alias"] });

    const after = readLockfile(repoDir)!;
    expect(after.catalog).toEqual(before.catalog);
    expect(after.entries["skill:demo"]).toEqual(before.entries["skill:demo"]);
    expect(after.entries["skill:sibling"]).toEqual(before.entries["skill:sibling"]);
    expect(snapshot(join(repoDir, ".agents/skills/sibling"))).toEqual(siblingBytes);
    expect(after.entries["skill:my-alias"]).toMatchObject({
      installedPath: "skills/my-alias",
      source: { kind: "github", repo: "new-owner/skills", path: "NewName", ref: "Release/Next", commit: NEW_SHA, digest: treeDigest(directory) },
    });
    expect(fs.readFileSync(join(repoDir, ".agents/skills/my-alias/SKILL.md"), "utf8")).toBe(skill("retargeted"));
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(replacement);
  });

  it("keeps the old artifact pin when a moving ref changes only the surrounding repository", async () => {
    const { directory } = await setupRemote();
    write(dirname(directory), "README.md", "Repository-only change\n");
    remote(REMOTE, directory, NEW_SHA);
    const before = snapshot(repoDir);

    const report = await run();

    expect(report).toMatchObject({ ok: true, updated: [], upToDate: ["skill:demo"] });
    expect(report.reports[0]).not.toHaveProperty("to");
    expect(readLockfile(repoDir)!.entries["skill:demo"]!.source).toMatchObject({ commit: OLD_SHA, ref: "main" });
    expect(snapshot(repoDir)).toEqual(before);
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(REMOTE);
  });

  it("keeps an exact SHA pin and never substitutes a moving branch", async () => {
    const source = `github:acme/skills/Skills/Upstream#${OLD_SHA}`;
    await setupRemote(source);
    const moving = join(root, "moving-head");
    write(moving, "SKILL.md", skill("new branch head"));
    remote(REMOTE, moving, NEW_SHA);
    const before = snapshot(repoDir);

    expect(await run()).toMatchObject({ ok: true, updated: [], upToDate: [], pinned: ["skill:demo"] });
    expect(snapshot(repoDir)).toEqual(before);
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(source);
  });

  it("requires an explicit source for legacy provenance even with force", async () => {
    await setupRemote();
    const lock = readLockfile(repoDir)!;
    lock.entries["skill:demo"]!.source = { kind: "legacy", catalog: lock.catalog, sourcePath: "skills/old/demo", pin: OLD_SHA };
    writeLockfile(repoDir, lock);
    const before = snapshot(repoDir);

    expect(await run({ force: true })).toMatchObject({ ok: false, updated: [], upToDate: [], legacy: ["skill:demo"], errors: [] });
    expect(snapshot(repoDir)).toEqual(before);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("binds identical legacy content to an explicit source without replacing artifact files", async () => {
    const { source, skillPath } = await setup();
    const lock = readLockfile(repoDir)!;
    lock.entries["skill:demo"]!.source = { kind: "legacy", catalog: lock.catalog, pin: OLD_SHA };
    writeLockfile(repoDir, lock);
    await sync(options());
    write(repoDir, "opencode.json", "Preserve this unsynchronized provider file\n");
    fs.utimesSync(skillPath, 1, 1);
    const stat = fs.lstatSync(skillPath);
    const before = snapshot(join(repoDir, ".agents"));

    const report = await run({ positionals: ["skill:demo"], source });

    expect(report).toMatchObject({ ok: true, updated: ["skill:demo"], localChanges: [], legacy: [] });
    expect(report.reports[0]).toMatchObject({ contentChanged: false });
    expect(readLockfile(repoDir)!.entries["skill:demo"]!.source).toEqual({
      kind: "local", root: join(catalogDir, "skills/code/demo"), path: "", digest: treeDigest(dirname(skillPath)),
    });
    expect(snapshot(join(repoDir, ".agents"))).toEqual(before);
    expect(fs.lstatSync(skillPath)).toMatchObject({ ino: stat.ino, mtimeMs: stat.mtimeMs });
    expect(fs.readFileSync(join(repoDir, "opencode.json"), "utf8")).toBe("Preserve this unsynchronized provider file\n");
  });

  it("rebinds a migrated Windows V1 path without moving the installed skill", async () => {
    const { source, skillPath, entry } = await setup();
    const lock = readLockfile(repoDir)!;
    const { installedPath: _path, source: _source, ...metadata } = entry;
    write(repoDir, "quiver.lock", JSON.stringify({ ...lock, version: 1, entries: {
      "skill:demo": { ...metadata, sourcePath: "skills\\demo", pin: null },
    } }));
    await migrate(options());
    const before = fs.readFileSync(skillPath, "utf8");

    expect(await run({ positionals: ["skill:demo"], source })).toMatchObject({ ok: true, updated: ["skill:demo"] });
    expect(readLockfile(repoDir)!.entries["skill:demo"]).toMatchObject({
      installedPath: "skills\\demo", source: { kind: "local" },
    });
    expect(fs.readFileSync(skillPath, "utf8")).toBe(before);
  });

  it("requires force for an explicitly selected legacy source with different content", async () => {
    const { source, sourceFile, skillPath } = await setup();
    const lock = readLockfile(repoDir)!;
    lock.entries["skill:demo"]!.source = { kind: "legacy", catalog: lock.catalog };
    writeLockfile(repoDir, lock);
    fs.writeFileSync(sourceFile, skill("v2"));
    const before = snapshot(repoDir);

    expect(await run({ positionals: ["skill:demo"], source })).toMatchObject({ ok: false, updated: [], localChanges: ["skill:demo"] });
    expect(snapshot(repoDir)).toEqual(before);
    expect(process.exitCode).toBe(1);
    expect(await run({ positionals: ["skill:demo"], source, force: true })).toMatchObject({ ok: true, updated: ["skill:demo"] });
    expect(fs.readFileSync(skillPath, "utf8")).toBe(skill("v2"));
    expect(readLockfile(repoDir)!.entries["skill:demo"]).toMatchObject({
      digest: treeDigest(dirname(sourceFile)), source: { kind: "local", digest: treeDigest(dirname(sourceFile)) },
    });
  });

  it("rebinds identical MCP config without rewriting it or losing tool snapshots and auth", async () => {
    const { entry, server } = await setupMcp();
    const source = "github:acme/servers/catalog#next";
    const directory = join(root, "new-servers");
    write(directory, "config.json", JSON.stringify({ mcpServers: { search: server }, opencode: { model: "foreign/model" } }));
    remote(source, directory, NEW_SHA);
    const configPath = join(repoDir, ".agents/config.json");
    fs.writeFileSync(configPath, JSON.stringify(JSON.parse(fs.readFileSync(configPath, "utf8")), null, 4) + "\n");
    fs.utimesSync(configPath, 1, 1);
    const before = fs.readFileSync(configPath, "utf8");
    const stat = fs.lstatSync(configPath);

    const report = await run({ positionals: ["mcp:search"], source });

    expect(report).toMatchObject({ ok: true, updated: ["mcp:search"] });
    expect(report.reports[0]).toMatchObject({ contentChanged: false });
    expect(readLockfile(repoDir)!.entries["mcp:search"]).toEqual({
      ...entry, source: { kind: "github", repo: "acme/servers", path: "catalog", ref: "next", commit: NEW_SHA, digest: entry.configDigest },
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.lstatSync(configPath)).toMatchObject({ ino: stat.ino, mtimeMs: stat.mtimeMs });
  });

  it("does not carry old-server snapshots into a source binding matching locally edited MCP config", async () => {
    const { config } = await setupMcp();
    const server = { transport: "http", url: "https://different.example.test/mcp" };
    write(repoDir, ".agents/config.json", JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, search: server } }));
    write(catalogDir, "config.json", JSON.stringify({ mcpServers: { search: server } }));

    expect(await run({ positionals: ["mcp:search"], source: `local:${catalogDir}` })).toMatchObject({
      ok: true, updated: ["mcp:search"],
    });
    const entry = readLockfile(repoDir)!.entries["mcp:search"]!;
    expect(entry).toMatchObject({ configDigest: jsonDigest(server), tools: null, toolsFetchedAt: null });
    expect(entry).not.toHaveProperty("authRequired");
  });

  it("resets MCP tool baselines on real config changes while preserving sibling config and local overlays", async () => {
    const { config } = await setupMcp();
    const server = { transport: "stdio", command: "never-execute-updated-server", args: ["--new"] };
    write(catalogDir, "config.json", JSON.stringify({
      shared: { foreign: true }, opencode: { model: "foreign/model" },
      mcpServers: { search: server, unselected: { transport: "stdio", command: "never-run" } },
    }));
    write(repoDir, ".agents/config.local.json", '{"mcpServers":{"search":{"enabled":false}}}\n');
    write(repoDir, ".env.local.example", "# Authored template\n");

    expect(await run({ positionals: ["mcp:search"] })).toMatchObject({ ok: true, updated: ["mcp:search"] });

    expect(readLockfile(repoDir)!.entries["mcp:search"]).toMatchObject({
      transport: "stdio", configDigest: jsonDigest(server), tools: null, toolsFetchedAt: null,
      source: { kind: "local", root: catalogDir, path: "", digest: jsonDigest(server) },
    });
    expect(JSON.parse(fs.readFileSync(join(repoDir, ".agents/config.json"), "utf8"))).toEqual({
      ...config, mcpServers: { ...config.mcpServers, search: server },
    });
    expect(fs.readFileSync(join(repoDir, ".agents/config.local.json"), "utf8")).toBe('{"mcpServers":{"search":{"enabled":false}}}\n');
    expect(fs.readFileSync(join(repoDir, ".agents/plugins/sibling.ts"), "utf8")).toBe("export const local = true;\n");
    expect(fs.readFileSync(join(repoDir, ".env.local.example"), "utf8")).toBe("# Authored template\n");
  });

  it("keeps the first update pinned when the second lock commit fails and emits one partial-error JSON report", async () => {
    const firstSource = "github:acme/first/skill#main";
    const secondSource = "github:acme/second/skill#release";
    const first = await setupRemote(firstSource, "a-first");
    const second = await setupRemote(secondSource, "b-second");
    const before = readLockfile(repoDir)!;
    fs.writeFileSync(join(first.directory, "SKILL.md"), skill("first v2"));
    fs.writeFileSync(join(second.directory, "SKILL.md"), skill("second v2"));
    remote(firstSource, first.directory, NEW_SHA);
    remote(secondSource, second.directory, NEW_SHA);
    const rename = fs.renameSync;
    let commits = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === join(repoDir, "quiver.lock") && ++commits === 2) {
        throw Object.assign(new Error("Injected second lock commit failure"), { code: "EIO" });
      }
      rename(from, to);
    });
    syncBuiltinESMExports();

    const report = await run();

    expect(commits).toBe(2);
    expect(report).toMatchObject({ ok: false, updated: ["skill:a-first"], errors: ["skill:b-second"], upToDate: [] });
    expect(report.reports).toEqual([
      expect.objectContaining({ id: "skill:a-first", status: "updated" }),
      expect.objectContaining({ id: "skill:b-second", status: "error", reason: "Injected second lock commit failure" }),
    ]);
    expect(readLockfile(repoDir)!.entries["skill:a-first"]).toMatchObject({ source: { commit: NEW_SHA, digest: treeDigest(first.directory) } });
    expect(readLockfile(repoDir)!.entries["skill:b-second"]).toEqual(before.entries["skill:b-second"]);
    expect(readLockfile(repoDir)!.catalog).toEqual(before.catalog);
    expect(fs.readFileSync(first.skillPath, "utf8")).toBe(skill("first v2"));
    expect(fs.readFileSync(second.skillPath, "utf8")).toBe(skill("v1"));
    expect(fs.readdirSync(repoDir).filter((name) => name.startsWith(".quiver-stage-") || name.startsWith("quiver.lock.tmp-"))).toEqual([]);
    expect(process.exitCode).toBe(2);
  });

  it("rejects local changes made during a source fetch even when force was requested", async () => {
    const { directory, skillPath } = await setupRemote();
    fs.writeFileSync(join(directory, "SKILL.md"), skill("v2"));
    remote(REMOTE, directory, NEW_SHA);
    const lockBefore = fs.readFileSync(join(repoDir, "quiver.lock"));
    vi.mocked(resolveGithubDirectory).mockImplementationOnce(async () => {
      fs.writeFileSync(skillPath, skill("edited during fetch"));
      return remoteSources.get(REMOTE)!;
    });

    const report = await run({ force: true });

    expect(report).toMatchObject({ ok: false, updated: [], upToDate: [], errors: ["skill:demo"] });
    expect(report.reports[0]!.reason).toMatch(/changed during the operation/);
    expect(fs.readFileSync(skillPath, "utf8")).toBe(skill("edited during fetch"));
    expect(fs.readFileSync(join(repoDir, "quiver.lock"))).toEqual(lockBefore);
    expect(fs.readdirSync(repoDir).sort()).toEqual([".agents", "quiver.lock"]);
    expect(process.exitCode).toBe(2);
  });
});
