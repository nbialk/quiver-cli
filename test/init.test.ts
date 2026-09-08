import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { DEFAULT_CATALOG_SOURCE, resolveCatalog } from "../src/catalog/resolve.js";
import { init } from "../src/commands/init.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";
import { PROVIDERS } from "../src/lockfile/schema.js";
import { resolveProviders } from "../src/providers/resolve.js";
import { resolveGithubDirectory } from "../src/sources/github.js";
import * as ui from "../src/ui/prompts.js";

vi.mock("../src/catalog/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/catalog/resolve.js")>();
  return { ...actual, resolveCatalog: vi.fn(actual.resolveCatalog) };
});
vi.mock("../src/sources/github.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/sources/github.js")>(),
  resolveGithubDirectory: vi.fn(),
}));
vi.mock("../src/ui/prompts.js", () => ({
  banner: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(),
  info: vi.fn(), step: vi.fn(), outro: vi.fn(), selectGrouped: vi.fn(),
}));

let catalogDir: string;
let repoDir: string;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const config = {
  shared: { model: "shared-model" },
  opencode: { model: "catalog-model" },
  tui: { theme: "catalog-theme" },
  claude: { settings: { permissions: { allow: [] } } },
  mcpServers: {
    selected: { transport: "http", url: "https://selected.example.test/mcp", headers: { Authorization: "Bearer ${QUIVER_INIT_SELECTED_TOKEN}" } },
    unselected: { transport: "http", url: "https://unselected.example.test/mcp", headers: { Authorization: "Bearer ${QUIVER_INIT_UNSELECTED_TOKEN}" } },
  },
  plugins: { rtk: { provider: "opencode", sourcePath: "plugins/opencode/rtk.ts", requires: [] } },
};

const write = (root: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  targetRoot: repoDir, force: false, all: false, json: false, verbose: false,
  accept: false, offline: false, dryRun: false, introspectStdio: false,
  providers: ["opencode"], catalog: `local:${catalogDir}`, positionals: [],
  ...overrides,
});

const interactive = (): void => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
};

const references = (): void => {
  write(catalogDir, "catalog.json", JSON.stringify({ version: 1, skills: {
    alias: { source: "github:acme/skills/upstream#main", description: "Reference metadata", group: "code" },
    unavailable: { source: "github:missing/repo/skill" },
  } }));
};

beforeEach(() => {
  catalogDir = mkdtempSync(join(tmpdir(), "quiver-init-catalog-"));
  repoDir = mkdtempSync(join(tmpdir(), "quiver-init-repo-"));
  write(catalogDir, "skills/code/cleanup/SKILL.md", "---\nname: cleanup\ndescription: Clean code\n---\n# Cleanup\n");
  write(catalogDir, "skills/code/cleanup/scripts/check.ts", "throw new Error('Must not execute');\n");
  write(catalogDir, "skills/code/cleanup/assets/data.bin", Buffer.from([0, 255, 42]));
  write(catalogDir, "skills/spare/SKILL.md", "# Spare\n");
  write(catalogDir, "commands/review.md", "# Review\n");
  write(catalogDir, "plugins/opencode/rtk.ts", "throw new Error('Must not import');\n");
  write(catalogDir, "config.json", JSON.stringify(config));
  write(catalogDir, "AGENTS.md", "# Catalog guide\n");
  write(catalogDir, "README.md", "# Must not copy\n");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
  vi.mocked(ui.selectGrouped).mockResolvedValue([]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(catalogDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("init", () => {
  it("initializes an empty V2 project with the configured default and no source resolution", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await init(options({ empty: true, catalog: null, providers: null, json: true }));

    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readLockfile(repoDir)).toMatchObject({ version: 2, catalog: { source: DEFAULT_CATALOG_SOURCE, resolved: null }, providers: [...PROVIDERS], entries: {} });
    expect(JSON.parse(readFileSync(join(repoDir, ".agents/config.json"), "utf8"))).toEqual({});
    expect(readdirSync(join(repoDir, ".agents"))).toEqual(["config.json"]);
    expect(existsSync(join(repoDir, "opencode.json"))).toBe(false);
    expect(readFileSync(join(repoDir, ".gitignore"), "utf8")).toContain(".env.local");
    expect(existsSync(join(repoDir, "README.md"))).toBe(false);
    expect(ui.selectGrouped).not.toHaveBeenCalled();
    expect(ui.banner).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: true, installed: [], providers: [...PROVIDERS] }));
  });

  it("preserves an existing authored config, guides and additional files during empty init", async () => {
    const authored = "{\n  \"shared\": {\"authored\": true},\n  \"mcpServers\": {}\n}\n";
    write(repoDir, ".agents/config.json", authored);
    write(repoDir, ".agents/AGENTS.md", "# Authored agent guide\n");
    write(repoDir, "AGENTS.md", "# Root guide\n");
    write(repoDir, "CLAUDE.md", "# Claude guide\n");
    write(repoDir, ".agents/notes.md", "Local notes\n");
    write(repoDir, "README.md", "# Project\n");
    await init(options({ empty: true, catalog: null }));
    expect(readFileSync(join(repoDir, ".agents/config.json"), "utf8")).toBe(authored);
    expect(readFileSync(join(repoDir, ".agents/AGENTS.md"), "utf8")).toBe("# Authored agent guide\n");
    expect(readFileSync(join(repoDir, "AGENTS.md"), "utf8")).toBe("# Root guide\n");
    expect(readFileSync(join(repoDir, "CLAUDE.md"), "utf8")).toBe("# Claude guide\n");
    expect(readFileSync(join(repoDir, ".agents/notes.md"), "utf8")).toBe("Local notes\n");
    expect(readFileSync(join(repoDir, "README.md"), "utf8")).toBe("# Project\n");
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it.each([{}, { force: true }, { empty: true, force: true }])("refuses an existing lockfile even with force: %j", async (flags) => {
    writeLockfile(repoDir, emptyLockfile(`local:${catalogDir}`));
    const before = readFileSync(join(repoDir, "quiver.lock"), "utf8");
    await expect(init(options({ all: true, ...flags }))).rejects.toThrow(/already exists.*never replaces/);
    expect(readFileSync(join(repoDir, "quiver.lock"), "utf8")).toBe(before);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(existsSync(join(repoDir, ".agents"))).toBe(false);
  });

  it.each([{ providers: [] }, { providers: [""] }, { providers: ["unknown"] }, { providers: ["opencode", ""] }])("validates explicit providers before network or writes: %j", async ({ providers }) => {
    await expect(init(options({ all: true, json: true, providers }))).rejects.toThrow(/provider/i);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ui.error).not.toHaveBeenCalled();
    expect(ui.banner).not.toHaveBeenCalled();
    expect(readdirSync(repoDir)).toEqual([]);
  });

  it.each([{}, { yes: true }, { json: true }, { json: true, yes: true }])("requires explicit empty/all without a TTY: %j", async (flags) => {
    await expect(init(options(flags))).rejects.toThrow(/--empty.*--all.*--yes/);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(ui.selectGrouped).not.toHaveBeenCalled();
    expect(readdirSync(repoDir)).toEqual([]);
  });

  it("never prompts in JSON mode, even when stdin is a TTY", async () => {
    interactive();
    await expect(init(options({ json: true, providers: null }))).rejects.toThrow(/--empty.*--all/);
    expect(ui.selectGrouped).not.toHaveBeenCalled();
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("installs all explicitly with per-entry local provenance and one JSON output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await init(options({ all: true, json: true }));
    const installed = ["skill:cleanup", "skill:spare", "command:review", "mcp:selected", "mcp:unselected", "plugin:rtk"];
    expect(Object.keys(readLockfile(repoDir)!.entries).sort()).toEqual([...installed].sort());
    expect(readLockfile(repoDir)!.entries["skill:cleanup"]).toMatchObject({
      installedPath: "skills/cleanup", source: { kind: "local", root: catalogDir, path: "skills/code/cleanup" },
    });
    expect(readFileSync(join(repoDir, ".agents/skills/cleanup/assets/data.bin"))).toEqual(Buffer.from([0, 255, 42]));
    expect(readFileSync(join(repoDir, ".agents/skills/cleanup/scripts/check.ts"), "utf8")).toContain("Must not execute");
    expect(readFileSync(join(repoDir, ".agents/AGENTS.md"), "utf8")).toBe("# Catalog guide\n");
    expect(lstatSync(join(repoDir, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repoDir, ".opencode/skills/cleanup"))).toContain(".agents/skills/cleanup");
    expect(existsSync(join(repoDir, "README.md"))).toBe(false);
    expect(existsSync(join(repoDir, ".agents/README.md"))).toBe(false);
    expect(ui.banner).not.toHaveBeenCalled();
    expect(ui.selectGrouped).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: true, installed, providers: ["opencode"] }));
  });

  it("seeds only shared/provider overlays and merges selected MCP definitions", async () => {
    interactive();
    vi.mocked(ui.selectGrouped).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce(["selected"]).mockResolvedValueOnce([]);
    await init(options());
    expect(JSON.parse(readFileSync(join(repoDir, ".agents/config.json"), "utf8"))).toEqual({
      shared: config.shared, opencode: config.opencode, tui: config.tui, claude: config.claude,
      mcpServers: { selected: config.mcpServers.selected },
    });
    expect(Object.keys(readLockfile(repoDir)!.entries)).toEqual(["mcp:selected"]);
    expect(existsSync(join(repoDir, ".agents/plugins"))).toBe(false);
    expect(existsSync(join(repoDir, ".agents/skills"))).toBe(false);
    const example = readFileSync(join(repoDir, ".env.local.example"), "utf8");
    expect(example).toContain("QUIVER_INIT_SELECTED_TOKEN");
    expect(example).not.toContain("QUIVER_INIT_UNSELECTED_TOKEN");
    expect(readFileSync(join(repoDir, "opencode.json"), "utf8")).not.toContain("unselected.example.test");
  });

  it("excludes plugins for providers that are not selected", async () => {
    await init(options({ all: true, providers: ["codex"] }));
    expect(readLockfile(repoDir)!.entries).not.toHaveProperty("plugin:rtk");
    expect(existsSync(join(repoDir, ".agents/plugins"))).toBe(false);
    expect(JSON.parse(readFileSync(join(repoDir, ".agents/config.json"), "utf8"))).not.toHaveProperty("plugins");
  });

  it("rejects an unsupported selected plugin provider before installing any entry", async () => {
    write(catalogDir, "config.json", JSON.stringify({ ...config, plugins: {
      rtk: { ...config.plugins.rtk, provider: "claude" },
    } }));
    await expect(init(options({ all: true, providers: ["claude"] }))).rejects.toThrow(/unsupported plugin provider/);
    expect(readdirSync(repoDir)).toEqual([]);
  });

  it("preserves existing authored overlays and real guides when installing a skill", async () => {
    interactive();
    vi.mocked(ui.selectGrouped).mockResolvedValueOnce(["cleanup"]);
    const authored = JSON.stringify({
      shared: { authored: true }, opencode: { model: "local-model" },
      mcpServers: { authored: { transport: "http", url: "https://authored.example.test" } },
      plugins: { missing: { provider: "opencode", sourcePath: "missing.ts" } },
    }, null, 4) + "\n";
    write(repoDir, ".agents/config.json", authored);
    write(repoDir, ".agents/AGENTS.md", "# Authored\n");
    write(repoDir, "AGENTS.md", "# Root authored\n");
    write(repoDir, "CLAUDE.md", "# Claude authored\n");
    write(repoDir, ".agents/notes.txt", "Keep\n");
    write(repoDir, ".env.local.example", "AUTHORED_EXAMPLE=\n");
    await init(options());
    expect(readFileSync(join(repoDir, ".agents/config.json"), "utf8")).toBe(authored);
    expect(readFileSync(join(repoDir, ".agents/AGENTS.md"), "utf8")).toBe("# Authored\n");
    expect(readFileSync(join(repoDir, "AGENTS.md"), "utf8")).toBe("# Root authored\n");
    expect(readFileSync(join(repoDir, "CLAUDE.md"), "utf8")).toBe("# Claude authored\n");
    expect(readFileSync(join(repoDir, ".agents/notes.txt"), "utf8")).toBe("Keep\n");
    expect(readFileSync(join(repoDir, ".env.local.example"), "utf8")).toBe("AUTHORED_EXAMPLE=\n");
    expect(Object.keys(readLockfile(repoDir)!.entries)).toEqual(["skill:cleanup"]);
    expect(readFileSync(join(repoDir, "opencode.json"), "utf8")).toContain("local-model");
  });

  it("offers unresolved references and fetches only the chosen alias", async () => {
    references();
    interactive();
    vi.mocked(ui.selectGrouped).mockResolvedValueOnce(["cleanup", "alias"]);
    vi.mocked(resolveGithubDirectory).mockResolvedValue({
      source: "github:acme/skills/upstream#main", root: join(catalogDir, "skills/code/cleanup"),
      repo: "acme/skills", path: "upstream", ref: "main", resolved: "a".repeat(40), fetchedAt: "2026-09-08T00:00:00.000Z",
    });
    await init(options());
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith("github:acme/skills/upstream#main");
    const groups = vi.mocked(ui.selectGrouped).mock.calls[0]![0].groups;
    expect(groups.flatMap(({ items }) => items)).toContainEqual(expect.objectContaining({ value: "alias", hint: "Reference metadata" }));
    expect(readLockfile(repoDir)!.entries["skill:alias"]).toMatchObject({
      installedPath: "skills/alias", source: { kind: "github", repo: "acme/skills", path: "upstream", ref: "main" }, frontmatter: { name: "cleanup" },
    });
    expect(existsSync(join(repoDir, ".agents/skills/unavailable"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fetch any references when only an owned skill is chosen", async () => {
    references();
    interactive();
    vi.mocked(ui.selectGrouped).mockResolvedValueOnce(["cleanup"]);
    await init(options());
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("leaves the project untouched if any selected reference cannot resolve", async () => {
    references();
    vi.mocked(resolveGithubDirectory).mockRejectedValue(new Error("Selected source unavailable"));
    await expect(init(options({ all: true }))).rejects.toThrow(/Selected source unavailable/);
    expect(readdirSync(repoDir)).toEqual([]);
  });

  it("rechecks the lock after source resolution instead of overwriting a concurrent initialization", async () => {
    const concurrent = JSON.stringify(emptyLockfile("github:other/catalog"));
    vi.mocked(resolveCatalog).mockImplementationOnce(async (source) => {
      write(repoDir, "quiver.lock", concurrent);
      return { source: source!, root: catalogDir };
    });
    await expect(init(options({ all: true }))).rejects.toThrow(/already exists/);
    expect(readFileSync(join(repoDir, "quiver.lock"), "utf8")).toBe(concurrent);
    expect(existsSync(join(repoDir, ".agents"))).toBe(false);
  });

  it.each(["cleanup", "CLEANUP"])("detects untracked nested skill name %s before writing a skeleton", async (name) => {
    write(repoDir, `.agents/skills/custom/${name}/SKILL.md`, "# Authored\n");
    await expect(init(options({ all: true }))).rejects.toThrow(/conflicts with existing/);
    expect(readFileSync(join(repoDir, `.agents/skills/custom/${name}/SKILL.md`), "utf8")).toBe("# Authored\n");
    expect(existsSync(join(repoDir, "quiver.lock"))).toBe(false);
    expect(existsSync(join(repoDir, ".agents/config.json"))).toBe(false);
    expect(existsSync(join(repoDir, ".agents/skills/cleanup"))).toBe(false);
  });

  it("rejects untracked MCP definitions before writing any selected entry", async () => {
    const authored = JSON.stringify({ mcpServers: { selected: { transport: "http", url: "https://authored.example.test" } } });
    write(repoDir, ".agents/config.json", authored);
    await expect(init(options({ all: true }))).rejects.toThrow(/mcp:selected.*conflicts/);
    expect(readFileSync(join(repoDir, ".agents/config.json"), "utf8")).toBe(authored);
    expect(existsSync(join(repoDir, "quiver.lock"))).toBe(false);
    expect(existsSync(join(repoDir, ".agents/skills"))).toBe(false);
  });

  it("does not replace an existing destination even if it has no SKILL.md", async () => {
    write(repoDir, ".agents/skills/cleanup/notes.md", "# Authored notes\n");
    await expect(init(options({ all: true }))).rejects.toThrow(/already exists/);
    expect(readFileSync(join(repoDir, ".agents/skills/cleanup/notes.md"), "utf8")).toBe("# Authored notes\n");
    expect(existsSync(join(repoDir, "quiver.lock"))).toBe(false);
  });

  it.each([".agents/config.json", ".gitignore", ".env.local", ".env.local.example", ".agents/AGENTS.md"])("preflights symlinked %s before writing", async (path) => {
    write(catalogDir, "outside.txt", "Untouched\n");
    mkdirSync(dirname(join(repoDir, path)), { recursive: true });
    symlinkSync(join(catalogDir, "outside.txt"), join(repoDir, path));
    await expect(init(options({ all: true }))).rejects.toThrow(/symlinked/);
    expect(readFileSync(join(catalogDir, "outside.txt"), "utf8")).toBe("Untouched\n");
    expect(existsSync(join(repoDir, "quiver.lock"))).toBe(false);
    expect(existsSync(join(repoDir, "opencode.json"))).toBe(false);
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("rejects a hard-linked gitignore before any writes", async () => {
    write(catalogDir, "outside.txt", "Untouched\n");
    linkSync(join(catalogDir, "outside.txt"), join(repoDir, ".gitignore"));
    await expect(init(options({ empty: true, catalog: null }))).rejects.toThrow(/regular file without hard links/);
    expect(readFileSync(join(catalogDir, "outside.txt"), "utf8")).toBe("Untouched\n");
    expect(existsSync(join(repoDir, ".agents"))).toBe(false);
  });

  it("does not copy an unsafe source guide or initialize partially", async () => {
    rmSync(join(catalogDir, "AGENTS.md"));
    symlinkSync("README.md", join(catalogDir, "AGENTS.md"));
    await expect(init(options({ all: true }))).rejects.toThrow(/Catalog guide.*symlinked/);
    expect(readdirSync(repoDir)).toEqual([]);
  });

  it("preserves an existing safe guide without reading an unused source guide", async () => {
    write(repoDir, ".agents/AGENTS.md", "# Authored\n");
    rmSync(join(catalogDir, "AGENTS.md"));
    symlinkSync("README.md", join(catalogDir, "AGENTS.md"));
    await init(options({ all: true }));
    expect(readFileSync(join(repoDir, ".agents/AGENTS.md"), "utf8")).toBe("# Authored\n");
  });

  it("rejects V1 reinitialization without migrating or touching existing content", async () => {
    const raw = JSON.stringify({ ...emptyLockfile(`local:${catalogDir}`), version: 1 });
    write(repoDir, "quiver.lock", raw);
    await expect(init(options({ empty: true, force: true, catalog: null }))).rejects.toThrow(/already exists/);
    expect(readFileSync(join(repoDir, "quiver.lock"), "utf8")).toBe(raw);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(existsSync(join(repoDir, ".agents"))).toBe(false);
  });
});

describe("init provider resolution", () => {
  it.each([{ all: true }, { yes: true }, { json: true }, { empty: true }])("uses all provider defaults without prompting for %j", async (flags) => {
    interactive();
    expect(await resolveProviders(options({ providers: null, ...flags }))).toEqual([...PROVIDERS]);
    expect(ui.selectGrouped).not.toHaveBeenCalled();
  });

  it("uses all defaults outside a TTY", async () => {
    expect(await resolveProviders(options({ providers: null }))).toEqual([...PROVIDERS]);
    expect(ui.selectGrouped).not.toHaveBeenCalled();
  });

  it("lets --yes confirm providers without selecting catalog entries", async () => {
    interactive();
    vi.mocked(ui.selectGrouped).mockResolvedValueOnce(["cleanup"]);
    await init(options({ providers: null, yes: true }));
    expect(readLockfile(repoDir)!.providers).toEqual([...PROVIDERS]);
    expect(Object.keys(readLockfile(repoDir)!.entries)).toEqual(["skill:cleanup"]);
    expect(vi.mocked(ui.selectGrouped).mock.calls[0]![0].message).toContain("Select skills");
  });
});
