import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { loadCatalog } from "../src/catalog/discover.js";
import { skillToEntry } from "../src/catalog/entries.js";
import { resolveCatalog } from "../src/catalog/resolve.js";
import { add } from "../src/commands/add.js";
import { selectFromCatalog } from "../src/commands/select.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";
import { prepareDirectSkill, type PreparedEntry } from "../src/sources/entry.js";
import { resolveGithubDirectory } from "../src/sources/github.js";
import * as ui from "../src/ui/prompts.js";

vi.mock("../src/catalog/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/catalog/resolve.js")>();
  return { ...actual, resolveCatalog: vi.fn(actual.resolveCatalog) };
});
vi.mock("../src/sources/entry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/sources/entry.js")>(),
  prepareDirectSkill: vi.fn(),
}));
vi.mock("../src/sources/github.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/sources/github.js")>(),
  resolveGithubDirectory: vi.fn(),
}));
vi.mock("../src/commands/select.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commands/select.js")>();
  return { ...actual, selectFromCatalog: vi.fn(actual.selectFromCatalog) };
});
vi.mock("../src/ui/prompts.js", () => ({
  success: vi.fn(), info: vi.fn(), error: vi.fn(), selectGrouped: vi.fn(),
}));

const skill = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;

let catalogDir: string | undefined;
let repoDir: string | undefined;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
});

afterEach(() => {
  for (const dir of [catalogDir, repoDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  catalogDir = undefined;
  repoDir = undefined;
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

const setup = (config: Record<string, unknown> = {}): void => {
  catalogDir = mkdtempSync(join(tmpdir(), "quiver-add-catalog-"));
  repoDir = mkdtempSync(join(tmpdir(), "quiver-add-repo-"));

  for (const name of ["installed", "new-skill"]) {
    mkdirSync(join(catalogDir, "skills", name), { recursive: true });
    writeFileSync(
      join(catalogDir, "skills", name, "SKILL.md"),
      skill(name, "catalog content"),
    );
  }
  writeFileSync(join(catalogDir, "config.json"), JSON.stringify(config));

  mkdirSync(join(repoDir, ".agents/skills/installed"), { recursive: true });
  writeFileSync(
    join(repoDir, ".agents/skills/installed/SKILL.md"),
    skill("installed", "catalog content"),
  );
  writeFileSync(join(repoDir, ".agents/config.json"), "{}\n");

  const source = `local:${catalogDir}`;
  const catalog = loadCatalog({ source, root: catalogDir });
  const lock = emptyLockfile(source);
  lock.providers = ["opencode"];
  const installed = catalog.skills.find((entry) => entry.name === "installed")!;
  lock.entries["skill:installed"] = skillToEntry(installed, {
    kind: "local", root: catalogDir, path: installed.sourcePath, digest: installed.digest,
  });
  writeLockfile(repoDir, lock);
};

const options = (id?: string, overrides: Partial<CliOptions> = {}): CliOptions => ({
  targetRoot: repoDir!,
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
  positionals: id ? [id] : [],
  ...overrides,
});

const directCandidate = (name = "my-alias"): PreparedEntry => {
  const catalog = loadCatalog({ source: `local:${catalogDir}`, root: catalogDir! });
  const selected = {
    ...catalog.skills.find((item) => item.name === "new-skill")!,
    name, sourcePath: `skills/${name}`,
  };
  return {
    id: `skill:${name}`,
    entry: skillToEntry(selected, {
      kind: "github", repo: "acme/skills", path: "upstream", ref: "main",
      commit: "a".repeat(40), digest: selected.digest,
    }),
    catalog: { ...catalog, config: {}, skills: [selected], commands: [], mcp: [], plugins: [] },
  };
};

const references = (): void => {
  writeFileSync(join(catalogDir!, "catalog.json"), JSON.stringify({ version: 1, skills: {
    remote: { source: "github:acme/skills/remote#main", description: "Unresolved metadata", group: "code" },
    unavailable: { source: "github:missing/repo/skill" },
  } }));
};

describe("add", () => {
  it("preserves a locally modified installed skill when adding another skill", async () => {
    setup();
    const installedPath = join(
      repoDir!,
      ".agents/skills/installed/SKILL.md",
    );
    writeFileSync(installedPath, skill("installed", "local modification"));

    await add(options("skill:new-skill"));

    expect(readFileSync(installedPath, "utf8")).toContain("local modification");
    expect(
      readFileSync(join(repoDir!, ".agents/skills/new-skill/SKILL.md"), "utf8"),
    ).toContain("catalog content");
    expect(readLockfile(repoDir!)!.entries).toHaveProperty("skill:new-skill");
  });

  it("merges a new MCP server without replacing existing config state", async () => {
    const newServer = {
      transport: "http",
      url: "https://new.example.test/mcp",
    };
    setup({
      shared: { source: true },
      mcpServers: { new: newServer },
      opencode: { source: true },
    });
    const existingConfig = {
      shared: { locallyModified: true },
      mcpServers: {
        existing: { transport: "http", url: "https://existing.example.test/mcp" },
      },
      plugins: { existing: { provider: "opencode", sourcePath: "existing.ts" } },
      opencode: { locallyModified: true },
      claude: { settings: { locallyModified: true } },
    };
    writeFileSync(
      join(repoDir!, ".agents/config.json"),
      JSON.stringify(existingConfig),
    );
    writeFileSync(join(repoDir!, ".agents/existing.ts"), "export {};\n");

    await add(options("mcp:new"));

    expect(
      JSON.parse(readFileSync(join(repoDir!, ".agents/config.json"), "utf8")),
    ).toEqual({
      ...existingConfig,
      mcpServers: { ...existingConfig.mcpServers, new: newServer },
    });
    expect(readLockfile(repoDir!)!.entries).toHaveProperty("mcp:new");
  });

  it("merges a plugin definition while preserving MCP and provider config", async () => {
    setup();
    mkdirSync(join(catalogDir!, "plugins/opencode"), { recursive: true });
    writeFileSync(join(catalogDir!, "plugins/opencode/new.ts"), "export {};\n");
    writeFileSync(
      join(catalogDir!, "config.json"),
      JSON.stringify({
        plugins: {
          new: {
            provider: "opencode",
            sourcePath: "plugins/opencode/new.ts",
            requires: [],
          },
        },
      }),
    );
    const existingConfig = {
      mcpServers: {
        existing: { transport: "http", url: "https://existing.example.test/mcp" },
      },
      opencode: { locallyModified: true },
    };
    writeFileSync(
      join(repoDir!, ".agents/config.json"),
      JSON.stringify(existingConfig),
    );

    await add(options("plugin:new"));

    expect(
      JSON.parse(readFileSync(join(repoDir!, ".agents/config.json"), "utf8")),
    ).toEqual({
      ...existingConfig,
      plugins: {
        new: {
          provider: "opencode",
          sourcePath: "plugins/opencode/new.ts",
          requires: [],
        },
      },
    });
    expect(
      readFileSync(join(repoDir!, ".agents/plugins/opencode/new.ts"), "utf8"),
    ).toBe("export {};\n");
  });

  it("preserves all skill resources and bypasses an unavailable discovery catalog for direct adds", async () => {
    setup();
    for (const dir of ["scripts", "assets", "references"]) {
      mkdirSync(join(catalogDir!, "skills/new-skill", dir));
    }
    writeFileSync(join(catalogDir!, "skills/new-skill/scripts/run.ts"), "throw new Error('Must not execute');\n");
    writeFileSync(join(catalogDir!, "skills/new-skill/assets/data.bin"), Buffer.from([0, 255, 42]));
    writeFileSync(join(catalogDir!, "skills/new-skill/references/guide.md"), "# Resource\n");
    vi.mocked(resolveCatalog).mockRejectedValue(new Error("Discovery catalog is unavailable"));
    const candidate = directCandidate();
    vi.mocked(prepareDirectSkill).mockResolvedValue(candidate);

    await add(options("github:acme/skills/upstream#main", { name: "my-alias" }));

    expect(prepareDirectSkill).toHaveBeenCalledExactlyOnceWith("github:acme/skills/upstream#main", "my-alias");
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(repoDir!, ".agents/skills/my-alias/assets/data.bin"))).toEqual(Buffer.from([0, 255, 42]));
    expect(readFileSync(join(repoDir!, ".agents/skills/my-alias/scripts/run.ts"), "utf8")).toContain("Must not execute");
    expect(readFileSync(join(repoDir!, ".agents/skills/my-alias/references/guide.md"), "utf8")).toBe("# Resource\n");
    expect(readLockfile(repoDir!)!.entries[candidate.id]).toEqual(candidate.entry);
    expect(readlinkSync(join(repoDir!, ".opencode/skills/my-alias"))).toContain(".agents/skills/my-alias");
  });

  it("loads the latest discovery catalog without using the global pin", async () => {
    setup();
    const lock = readLockfile(repoDir!)!;
    lock.catalog.source = "github:acme/catalog#main";
    lock.catalog.resolved = "a".repeat(40);
    writeLockfile(repoDir!, lock);
    vi.mocked(resolveCatalog).mockResolvedValue({
      source: lock.catalog.source, root: catalogDir!, ref: "main", resolved: "b".repeat(40),
    });

    await add(options("new-skill"));

    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith("github:acme/catalog#main");
    expect(readLockfile(repoDir!)!.entries["skill:new-skill"]!.source).toMatchObject({
      kind: "github", repo: "acme/catalog", path: "skills/new-skill", commit: "b".repeat(40),
    });
    expect(readLockfile(repoDir!)!.catalog).toEqual(lock.catalog);
  });

  it("does not retarget an already installed catalog ID or fetch its current catalog", async () => {
    setup();
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    vi.mocked(resolveCatalog).mockRejectedValue(new Error("Unavailable"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await add(options("skill:installed", { json: true }));

    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: true, added: [], alreadyInstalled: ["skill:installed"] }));
  });

  it("treats direct source identity as unchanged when only commit and digests change", async () => {
    setup();
    const candidate = directCandidate();
    vi.mocked(prepareDirectSkill).mockResolvedValue(candidate);
    await add(options("github:acme/skills/upstream#main", { name: "my-alias" }));
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    const changed = structuredClone(candidate);
    Object.assign(changed.entry.source, { repo: "ACME/SKILLS", commit: "b".repeat(40), digest: `sha256:${"0".repeat(64)}` });
    vi.mocked(prepareDirectSkill).mockResolvedValue(changed);
    writeFileSync(join(repoDir!, ".agents/skills/my-alias/SKILL.md"), "# Local edit\n");

    await add(options("github:ACME/SKILLS/upstream#main", { name: "my-alias", force: true }));

    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
    expect(readFileSync(join(repoDir!, ".agents/skills/my-alias/SKILL.md"), "utf8")).toBe("# Local edit\n");
    expect(ui.info).toHaveBeenLastCalledWith("Already installed: skill:my-alias.");
  });

  it.each([{ repo: "other/skills" }, { path: "another" }, { ref: "release" }])("rejects direct alias retargeting for identity change %j", async (change) => {
    setup();
    const candidate = directCandidate();
    vi.mocked(prepareDirectSkill).mockResolvedValue(candidate);
    await add(options("github:acme/skills/upstream#main", { name: "my-alias" }));
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    const changed = structuredClone(candidate);
    Object.assign(changed.entry.source, change);
    vi.mocked(prepareDirectSkill).mockResolvedValue(changed);

    await expect(add(options("github:other/skills/another#release", { name: "my-alias", force: true }))).rejects.toThrow(/different source.*update.*--source/);

    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it.each(["installed", "INSTALLED"])("rejects an alias colliding with installed %s from another authority", async (alias) => {
    setup();
    vi.mocked(prepareDirectSkill).mockResolvedValue(directCandidate(alias));
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    await expect(add(options("github:acme/skills/upstream#main", { name: alias }))).rejects.toThrow(/different source|conflicts with existing/);
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
  });

  it("rejects an untracked nested skill with the selected name without overwriting it", async () => {
    setup();
    mkdirSync(join(repoDir!, ".agents/skills/custom/new-skill"), { recursive: true });
    writeFileSync(join(repoDir!, ".agents/skills/custom/new-skill/SKILL.md"), "# Authored\n");
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    await expect(add(options("new-skill", { force: true }))).rejects.toThrow(/conflicts with existing/);
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
    expect(readFileSync(join(repoDir!, ".agents/skills/custom/new-skill/SKILL.md"), "utf8")).toBe("# Authored\n");
    expect(existsSync(join(repoDir!, ".agents/skills/new-skill"))).toBe(false);
  });

  it("uses installed paths for provider generation rather than discovering unrelated duplicate names", async () => {
    setup();
    for (const group of ["one", "two"]) {
      mkdirSync(join(repoDir!, `.agents/skills/${group}/untracked`), { recursive: true });
      writeFileSync(join(repoDir!, `.agents/skills/${group}/untracked/SKILL.md`), "# Untracked\n");
    }
    await add(options("new-skill"));
    expect(existsSync(join(repoDir!, ".opencode/skills/new-skill"))).toBe(true);
    expect(existsSync(join(repoDir!, ".opencode/skills/untracked"))).toBe(false);
  });

  it("resolves only a selected reference and keeps its catalog alias", async () => {
    setup();
    references();
    vi.mocked(resolveGithubDirectory).mockResolvedValue({
      source: "github:acme/skills/remote#main", root: join(catalogDir!, "skills/new-skill"),
      repo: "acme/skills", path: "remote", ref: "main", resolved: "a".repeat(40), fetchedAt: "2026-09-08T00:00:00.000Z",
    });
    await add(options("remote"));
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith("github:acme/skills/remote#main");
    expect(readLockfile(repoDir!)!.entries["skill:remote"]).toMatchObject({
      installedPath: "skills/remote", source: { repo: "acme/skills", path: "remote" }, frontmatter: { name: "new-skill" },
    });
  });

  it("does not fetch unselected references when adding an owned catalog entry", async () => {
    setup();
    references();
    await add(options("new-skill"));
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("rejects ambiguous bare names without writing, while typed IDs stay usable", async () => {
    setup();
    mkdirSync(join(catalogDir!, "commands"));
    writeFileSync(join(catalogDir!, "commands/new-skill.md"), "# Command\n");
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    await expect(add(options("new-skill"))).rejects.toThrow(/Ambiguous.*skill:new-skill.*command:new-skill/);
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
    await add(options("command:new-skill"));
    expect(readLockfile(repoDir!)!.entries).toHaveProperty("command:new-skill");
  });

  it.each([{}, { yes: true }, { json: true }, { yes: true, json: true }])("requires an explicit selection without a TTY: %j", async (flags) => {
    setup();
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    await expect(add(options(undefined, flags))).rejects.toThrow(/No entry selected.*--all.*--yes/);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(selectFromCatalog).not.toHaveBeenCalled();
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
  });

  it("browses unresolved metadata excluding installed IDs and unsupported plugins", async () => {
    setup();
    references();
    mkdirSync(join(catalogDir!, "plugins"));
    writeFileSync(join(catalogDir!, "plugins/new.ts"), "export {};\n");
    writeFileSync(join(catalogDir!, "config.json"), JSON.stringify({ plugins: {
      new: { provider: "opencode", sourcePath: "plugins/new.ts" },
    } }));
    const lock = readLockfile(repoDir!)!;
    lock.providers = ["claude"];
    writeLockfile(repoDir!, lock);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.mocked(ui.selectGrouped).mockResolvedValue(["new-skill"]);

    await add(options(undefined, { yes: true }));

    const [available, settings] = vi.mocked(selectFromCatalog).mock.calls[0]!;
    expect(available.skills.map(({ name }) => name)).toEqual(["new-skill", "remote", "unavailable"]);
    expect(available.skills.find(({ name }) => name === "remote")!.frontmatter.description).toBe("Unresolved metadata");
    expect(available.plugins).toEqual([]);
    expect(settings).toEqual({ interactive: true, providers: ["claude"] });
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("rejects an empty interactive selection without changes", async () => {
    setup();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.mocked(ui.selectGrouped).mockResolvedValue([]);
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    await expect(add(options())).rejects.toThrow(/No entries selected/);
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
  });

  it("selects all remaining entries explicitly and emits exactly one JSON object", async () => {
    setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await add(options(undefined, { all: true, json: true }));
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: true, added: ["skill:new-skill"], alreadyInstalled: [] }));
    expect(ui.selectGrouped).not.toHaveBeenCalled();
    expect(ui.success).not.toHaveBeenCalled();
    expect(ui.info).not.toHaveBeenCalled();
  });

  it("prepares every selected source before any project write", async () => {
    setup();
    references();
    vi.mocked(resolveGithubDirectory).mockRejectedValue(new Error("Selected repository unavailable"));
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    await expect(add(options(undefined, { all: true }))).rejects.toThrow(/Selected repository unavailable/);
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
    expect(existsSync(join(repoDir!, ".agents/skills/new-skill"))).toBe(false);
    expect(existsSync(join(repoDir!, "opencode.json"))).toBe(false);
  });

  it("validates plugin providers before installing an explicit plugin", async () => {
    setup();
    mkdirSync(join(catalogDir!, "plugins"));
    writeFileSync(join(catalogDir!, "plugins/new.ts"), "export {};\n");
    writeFileSync(join(catalogDir!, "config.json"), JSON.stringify({ plugins: { new: { provider: "opencode", sourcePath: "plugins/new.ts" } } }));
    const lock = readLockfile(repoDir!)!;
    lock.providers = ["codex"];
    writeLockfile(repoDir!, lock);
    await expect(add(options("plugin:new"))).rejects.toThrow(/requires the opencode provider/);
    expect(readLockfile(repoDir!)).toEqual(lock);
    expect(existsSync(join(repoDir!, ".agents/plugins"))).toBe(false);
  });

  it("rejects overlapping selected artifact paths before installing the first entry", async () => {
    setup();
    mkdirSync(join(catalogDir!, "plugins"));
    writeFileSync(join(catalogDir!, "plugins/shared.ts"), "export {};\n");
    writeFileSync(join(catalogDir!, "config.json"), JSON.stringify({ plugins: {
      one: { provider: "opencode", sourcePath: "plugins/shared.ts" },
      two: { provider: "opencode", sourcePath: "plugins/shared.ts" },
    } }));
    const before = readFileSync(join(repoDir!, "quiver.lock"), "utf8");
    await expect(add(options(undefined, { all: true }))).rejects.toThrow(/conflicting installed path/);
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(before);
    expect(existsSync(join(repoDir!, ".agents/skills/new-skill"))).toBe(false);
  });

  it("rejects --name on catalog entries before discovery", async () => {
    setup();
    await expect(add(options("new-skill", { name: "alias" }))).rejects.toThrow(/--name.*direct GitHub/);
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("requires a V2 lockfile before preparing a direct source or mutating anything", async () => {
    setup();
    const raw = JSON.stringify({ ...emptyLockfile(`local:${catalogDir}`), version: 1 });
    writeFileSync(join(repoDir!, "quiver.lock"), raw);
    await expect(add(options("github:acme/skills"))).rejects.toThrow(/version 1.*migrate/);
    expect(prepareDirectSkill).not.toHaveBeenCalled();
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(readFileSync(join(repoDir!, "quiver.lock"), "utf8")).toBe(raw);
    expect(existsSync(join(repoDir!, "opencode.json"))).toBe(false);
  });
});
