import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { loadCatalog, type CatalogConfig } from "../src/catalog/discover.js";
import { commandToEntry, mcpToEntry, pluginToEntry, skillToEntry } from "../src/catalog/entries.js";
import { resolveCatalog } from "../src/catalog/resolve.js";
import { sync } from "../src/commands/sync.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";
import { introspect } from "../src/mcp/introspect.js";
import { writeProviders } from "../src/providers/write.js";
import * as ui from "../src/ui/prompts.js";

vi.mock("../src/catalog/resolve.js", () => ({ resolveCatalog: vi.fn() }));
vi.mock("../src/commands/gitignore.js", () => ({ ignoredSourcePaths: () => [] }));
vi.mock("../src/mcp/introspect.js", () => ({ introspect: vi.fn() }));
vi.mock("../src/providers/write.js", () => ({ writeProviders: vi.fn(), formatWriteResult: () => [] }));
vi.mock("../src/ui/prompts.js", () => ({ error: vi.fn(), warn: vi.fn(), success: vi.fn(), block: vi.fn() }));

let repoDir: string;

const setup = (version: 1 | 2) => {
  repoDir = mkdtempSync(join(tmpdir(), "quiver-sync-"));
  const root = join(repoDir, ".agents");
  mkdirSync(join(root, "skills/demo"), { recursive: true });
  mkdirSync(join(root, "commands"));
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Original\nversion: v1\n---\nOriginal\n");
  writeFileSync(join(root, "commands/demo.md"), "Original command\n");
  writeFileSync(join(root, "plugins/demo.ts"), "export {};\n");
  const config: CatalogConfig = {
    shared: { custom: true },
    opencode: { model: "custom/model" },
    tui: { theme: "custom" },
    claude: { settings: { custom: true } },
    mcpServers: { demo: { transport: "http", url: "https://example.test/mcp" } },
    plugins: { demo: { provider: "opencode", sourcePath: "plugins/demo.ts", requires: [] } },
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(root, "config.local.json"), '{"mcpServers":{"demo":{"enabled":false}}}\n');
  writeFileSync(join(root, "AGENTS.md"), "Local instructions\n");
  writeFileSync(join(repoDir, "AGENTS.md"), "Existing root instructions\n");
  writeFileSync(join(repoDir, "CLAUDE.md"), "Existing Claude instructions\n");
  const catalog = loadCatalog({ source: `local:${root}`, root });
  const source = (path: string, digest: string) => ({ kind: "local" as const, root, path, digest });
  const lock = emptyLockfile(`local:${root}`);
  lock.providers = ["opencode"];
  const skill = catalog.skills[0]!;
  const command = catalog.commands[0]!;
  const plugin = catalog.plugins[0]!;
  const mcp = catalog.mcp[0]!;
  lock.entries = {
    "skill:demo": skillToEntry(skill, source(skill.sourcePath, skill.digest)),
    "command:demo": commandToEntry(command, source(command.sourcePath, command.digest)),
    "plugin:demo": pluginToEntry(plugin, source(plugin.sourcePath, plugin.digest)),
    "mcp:demo": mcpToEntry(mcp, source("config.json", mcp.configDigest)),
  };
  if (version === 1) {
    const entries = Object.fromEntries(Object.entries(lock.entries).map(([id, entry]) => {
      const { source: _source, ...metadata } = entry;
      if ("installedPath" in metadata) {
        const { installedPath, ...rest } = metadata;
        return [id, { ...rest, sourcePath: installedPath, ...(entry.type === "skill" ? { pin: "tag:v1" } : {}) }];
      }
      return [id, metadata];
    }));
    writeFileSync(join(repoDir, "quiver.lock"), JSON.stringify({ ...lock, version, entries }, null, 4) + "\n");
  } else {
    writeLockfile(repoDir, lock);
  }
  return { root, config, lock };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  targetRoot: repoDir,
  force: false,
  all: false,
  json: false,
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

beforeEach(() => {
  process.exitCode = 0;
  vi.clearAllMocks();
  vi.mocked(writeProviders).mockReturnValue({ generated: [], linked: [], removed: [] });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  expect(resolveCatalog).not.toHaveBeenCalled();
  expect(introspect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("sync", () => {
  it.each([1, 2] as const)("generates from local edits without changing V%s lock bytes or local overlays/roots", async (version) => {
    const { root, config } = setup(version);
    const lockBytes = readFileSync(join(repoDir, "quiver.lock"), "utf8");
    const beforeLock = readLockfile(repoDir)!;
    writeFileSync(join(root, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Edited\nversion: v2\n---\nLocal skill\n");
    writeFileSync(join(root, "commands/demo.md"), "Local command\n");
    writeFileSync(join(root, "plugins/demo.ts"), "export const local = true;\n");
    config.plugins!.demo!.requires = ["node"];
    config.mcpServers!.demo = { transport: "stdio", command: "foreign-code" };
    writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 4) + "\n");
    const preserved = [".agents/config.json", ".agents/config.local.json", ".agents/AGENTS.md", "AGENTS.md", "CLAUDE.md"];
    const beforeFiles = preserved.map((path) => readFileSync(join(repoDir, path), "utf8"));

    await sync(options());

    expect(readFileSync(join(repoDir, "quiver.lock"), "utf8")).toBe(lockBytes);
    expect(preserved.map((path) => readFileSync(join(repoDir, path), "utf8"))).toEqual(beforeFiles);
    expect(writeProviders).toHaveBeenCalledTimes(1);
    const [target, catalog, passedLock] = vi.mocked(writeProviders).mock.calls[0]!;
    expect(target).toBe(repoDir);
    expect(catalog.config).toEqual(config);
    expect(catalog.skills[0]!.frontmatter).toMatchObject({ description: "Edited", version: "v2" });
    expect(catalog.mcp[0]!.server).toEqual(config.mcpServers!.demo);
    expect(catalog.plugins[0]!.requires).toEqual(["node"]);
    expect(passedLock).toEqual(beforeLock);
    for (const id of Object.keys(beforeLock.entries)) expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining(id));
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("Baselines were not changed"));
    expect(process.exitCode).toBe(0);
  });

  it("warns about missing locked artifacts and still generates available local entries", async () => {
    const { root, config } = setup(2);
    const before = readFileSync(join(repoDir, "quiver.lock"), "utf8");
    rmSync(join(root, "skills/demo/SKILL.md"));
    rmSync(join(root, "commands/demo.md"));
    rmSync(join(root, "plugins/demo.ts"));
    delete config.mcpServers!.demo;
    writeFileSync(join(root, "config.json"), JSON.stringify(config));

    await sync(options());

    expect(readFileSync(join(repoDir, "quiver.lock"), "utf8")).toBe(before);
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("missing local entries"));
    for (const id of ["skill:demo", "command:demo", "plugin:demo", "mcp:demo"]) expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining(id));
    expect(writeProviders).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeProviders).mock.calls[0]![1]).toMatchObject({ skills: [], commands: [], plugins: [], mcp: [] });
  });

  it.each([{ providers: ["claude"] }, { providers: [] }])("rejects --providers=$providers with an actionable hint and no writes", async ({ providers }) => {
    setup(2);
    const before = readFileSync(join(repoDir, "quiver.lock"), "utf8");

    await sync(options({ providers }));

    expect(readFileSync(join(repoDir, "quiver.lock"), "utf8")).toBe(before);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining("quiver-cli providers"));
    expect(writeProviders).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not generate providers from unsafe local content", async () => {
    const { root } = setup(2);
    const before = readFileSync(join(repoDir, "quiver.lock"), "utf8");
    symlinkSync(join(repoDir, "AGENTS.md"), join(root, "skills/demo/external.md"));

    await sync(options());

    expect(readFileSync(join(repoDir, "quiver.lock"), "utf8")).toBe(before);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining("Unsafe local entries"));
    expect(writeProviders).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
