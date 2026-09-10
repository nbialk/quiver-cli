import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parse, resolveInstalledId, run, type CliOptions } from "../src/cli.js";
import { fileDigest, jsonDigest, treeDigest } from "../src/catalog/digest.js";
import { add } from "../src/commands/add.js";
import { init } from "../src/commands/init.js";
import { selectFromCatalog } from "../src/commands/select.js";
import { update } from "../src/commands/update.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";
import type { Lockfile, SkillEntry } from "../src/lockfile/schema.js";
import * as ui from "../src/ui/prompts.js";
import * as notifier from "../src/version/notifier.js";

vi.mock("../src/commands/init.js", () => ({
  init: vi.fn(async (options: CliOptions) => {
    if (options.json) console.log(JSON.stringify({ ok: true }));
  }),
}));
vi.mock("../src/commands/add.js", () => ({
  add: vi.fn(async (options: CliOptions) => {
    if (options.json) console.log(JSON.stringify({ ok: true }));
  }),
}));
vi.mock("../src/commands/update.js", () => ({
  update: vi.fn(async (options: CliOptions) => {
    if (options.json) console.log(JSON.stringify({ ok: true, updated: ["skill:demo"] }));
  }),
}));

describe("parse", () => {
  it("checks online by default and uses offline as the single local-only switch", () => {
    expect(parse(["check"])).toMatchObject({ options: { offline: false }, unknownFlags: [] });
    expect(parse(["check", "--offline"])).toMatchObject({ options: { offline: true }, unknownFlags: [] });
    expect(parse(["check", "--check-updates"]).unknownFlags).toEqual(["--check-updates"]);
  });
  it("defaults to help with no args", () => {
    const { command, unknownFlags } = parse([]);
    expect(command).toBe("help");
    expect(unknownFlags).toEqual([]);
  });

  it("accepts known boolean flags", () => {
    const { options, unknownFlags } = parse([
      "check",
      "--json",
      "--offline",
      "-V",
    ]);
    expect(unknownFlags).toEqual([]);
    expect(options.json).toBe(true);
    expect(options.offline).toBe(true);
    expect(options.verbose).toBe(true);
  });

  it("accepts known value flags", () => {
    const { options, unknownFlags } = parse([
      "init",
      "--providers=claude,opencode",
      "--catalog=github:acme/cat",
    ]);
    expect(unknownFlags).toEqual([]);
    expect(options.providers).toEqual(["claude", "opencode"]);
    expect(options.catalog).toBe("github:acme/cat");
  });

  it("reports unknown flags", () => {
    const { unknownFlags } = parse(["check", "--jsonn", "--nope"]);
    expect(unknownFlags).toEqual(["--jsonn", "--nope"]);
  });

  it.each([
    ["init", "--providers"],
    ["update", "demo", "--source"],
  ])("rejects a value flag written as a bare boolean flag: %j", (...args) => {
    const { unknownFlags } = parse(args);
    expect(unknownFlags).toEqual([args.at(-1)]);
  });

  it("collects positionals separately from flags", () => {
    const { command, options, unknownFlags } = parse([
      "remove",
      "mcp:context7",
      "--force",
    ]);
    expect(command).toBe("remove");
    expect(options.positionals).toEqual(["mcp:context7"]);
    expect(options.force).toBe(true);
    expect(unknownFlags).toEqual([]);
  });

  it.each(["--yes", "-y"])("keeps %s separate from explicit --all", (flag) => {
    expect(parse(["init", flag]).options).toMatchObject({ yes: true, all: false });
    expect(parse(["init", flag, "--all"]).options).toMatchObject({ yes: true, all: true });
    expect(parse(["add", flag]).options).toMatchObject({ yes: true, all: false });
    expect(parse(["add", flag, "--all"]).options).toMatchObject({ yes: true, all: true });
  });

  it("accepts add with no selection, explicit all, or one positional", () => {
    expect(parse(["add"]).options).toMatchObject({ positionals: [], all: false, name: null });
    expect(parse(["add", "--all"]).options).toMatchObject({ positionals: [], all: true, name: null });
    expect(parse(["add", "demo"]).options.positionals).toEqual(["demo"]);
    expect(parse(["add", "github:acme/skills/demo"]).options.positionals).toEqual(["github:acme/skills/demo"]);
  });

  it("returns the new optional fields", () => {
    expect(parse(["init", "--empty"]).options).toMatchObject({ empty: true, yes: false, source: null, name: null });
    expect(parse(["add", "github:acme/skills/demo", "--name=alias"]).options.name).toBe("alias");
  });

  it.each([
    "github:acme/new/demo#feature/branch",
    "local:/tmp/skills",
    `local:${join(tmpdir(), "custom skills")}`,
  ])("accepts an explicit targeted update source: %s", (source) => {
    expect(parse(["update", "demo", `--source=${source}`])).toMatchObject({
      command: "update", options: { positionals: ["demo"], source }, unknownFlags: [],
    });
  });

  it.each([
    ["--help", "init", "--force"],
    ["init", "--catalog=", "--help"],
    ["unknown", "--nope", "-h"],
  ])("prioritizes help anywhere: %j", (...args) => {
    expect(parse(args)).toMatchObject({ command: "help", unknownFlags: [] });
  });

  it.each([
    ["init", "--catalog="],
    ["init", "--providers= "],
    ["init", "--catalog=a", "--catalog=b"],
    ["init", "--yes", "-y"],
    ["remove", "demo", "-f", "--force"],
    ["init", "--providers=claude,,codex"],
    ["init", "--providers=claude,claude"],
    ["init", "--providers=unknown"],
    ["init", "--empty", "--all"],
    ["init", "--empty", "--catalog=github:acme/catalog"],
    ["init", "--force"],
    ["add", "demo", "--force"],
    ["add", "demo", "--all"],
    ["add", "github:acme/skills", "--all"],
    ["add", "--name=alias"],
    ["add", "--all", "--name=alias"],
    ["add", "demo", "--name=alias"],
    ["add", "local:/tmp/skills", "--name=alias"],
    ["add", "github:acme/skills", "--name=../bad"],
    ["add", "github:acme/skills", "--name=alias", "--all"],
    ["update", "--source=github:acme/skills"],
    ["update", "--source=local:/tmp/skills"],
    ["update", "demo", "--source="],
    ["update", "demo", "--source=github:"],
    ["update", "demo", "--source=local:"],
    ["update", "demo", "--source=local:.agents"],
    ["update", "demo", "--source=local:./skills"],
    ["update", "demo", "--source=local:../skills"],
    ["update", "demo", "--source=local:~/skills"],
    ["update", "demo", "--source=arbitrary"],
    ["update", "demo", "--source=/tmp/skills"],
    ["update", "demo", "--source=https://github.com/acme/skills"],
    ["update", "demo", "--source", "github:acme/skills"],
    ["update", "--all"],
    ["check", "--accept"],
    ["check", "demo", "--all"],
    ["check", "--dry-run"],
    ["check", "--offline", "--introspect-stdio"],
    ["sync", "--providers=claude"],
    ["sync", "--json"],
    ["remove", "demo", "--json"],
    ["providers", "--json"],
    ["disable", "demo", "--json"],
    ["providers", "claude", "--providers=codex"],
    ["providers", "claude,,codex"],
    ["add", "demo", "other"],
    ["remove", "demo", "other"],
    ["check", "demo", "other"],
    ["list", "demo"],
    ["migrate", "demo"],
    ["add", ""],
    ["upstream"],
    ["version", "--version"],
  ])("rejects invalid arguments: %j", (...args) => {
    expect(() => parse(args)).toThrow();
  });

  it("retains aliases and scoped acceptance", () => {
    expect(parse(["rm", "demo"]).command).toBe("remove");
    expect(parse(["ls"]).command).toBe("list");
    expect(parse(["check", "demo", "--accept"]).options.accept).toBe(true);
    expect(parse(["check", "--all", "--accept"]).options.all).toBe(true);
  });
});

describe("CLI dispatch", () => {
  let dir: string;
  let lock: Lockfile;
  const original = { argv: process.argv, exitCode: process.exitCode, stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "quiver-cli-"));
    mkdirSync(join(dir, ".agents"));
    lock = emptyLockfile("github:unreachable/catalog");
    lock.providers = ["claude"];
    writeLockfile(dir, lock);
    process.exitCode = 0;
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ui, "error").mockResolvedValue(undefined);
    vi.spyOn(ui, "warn").mockResolvedValue(undefined);
    vi.spyOn(ui, "info").mockResolvedValue(undefined);
    vi.spyOn(ui, "success").mockResolvedValue(undefined);
    vi.spyOn(ui, "step").mockResolvedValue(undefined);
    vi.spyOn(ui, "block").mockImplementation(() => {});
    vi.spyOn(ui, "selectGrouped").mockRejectedValue(new Error("Unexpected prompt"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    vi.spyOn(notifier, "checkForUpdate").mockResolvedValue({ current: "1.0.0", latest: null, updateAvailable: false });
  });

  afterEach(() => {
    process.argv = original.argv;
    process.exitCode = original.exitCode;
    process.stdin.isTTY = original.stdin;
    process.stdout.isTTY = original.stdout;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const invoke = async (...args: string[]): Promise<void> => {
    process.argv = ["node", "quiver-cli", ...args];
    await run();
  };

  const installSkill = (): string => {
    const path = join(dir, ".agents/skills/group/demo");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "# Demo\n");
    const digest = treeDigest(path);
    lock.entries["skill:demo"] = {
      type: "skill", installedPath: "skills/group/demo", digest,
      frontmatter: { name: null, description: null, version: null },
      source: { kind: "local", root: "/unavailable/source", path: "demo", digest },
    };
    writeLockfile(dir, lock);
    return path;
  };

  const jsonOutput = () => {
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(ui.error).not.toHaveBeenCalled();
    return JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
  };

  const installMcp = (): void => {
    const server = { transport: "http", url: "https://docs.example/mcp" };
    const digest = jsonDigest(server);
    lock.entries["mcp:docs"] = {
      type: "mcp", transport: "http", configDigest: digest,
      source: { kind: "local", root: "/unavailable/source", path: "config.json", digest },
      tools: {}, toolsFetchedAt: "2026-09-08T00:00:00.000Z",
    };
    writeFileSync(join(dir, ".agents/config.json"), JSON.stringify({ mcpServers: { docs: server } }));
    writeLockfile(dir, lock);
  };

  it("does not initialize or access the network for no command or help", async () => {
    await invoke();
    await invoke("init", "--catalog=", "--help");
    expect(init).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls[0]![0]).not.toContain("upstream");
  });

  it.each(["version", "--version", "-v"])("displays the local version for %s", async (command) => {
    await invoke(command, "--json");
    expect(jsonOutput()).toEqual({ ok: true, version: notifier.getCurrentVersion() });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["init", "--typo"], ["init", "--catalog="], ["init", "--force"],
    ["add", "demo", "other"], ["add", "demo", "--all"],
    ["add", "github:acme/skills", "--all"], ["add", "--all", "--name=alias"],
    ["add", "local:/tmp/skills", "--name=alias"],
    ["update", "demo", "--source"], ["update", "demo", "--source="],
    ["update", "demo", "--source", "github:acme/skills"],
    ["update", "demo", "--source=arbitrary"], ["update", "demo", "--source=local:.agents"],
    ["update", "--source=github:acme/skills"], ["update", "--source=local:/tmp/skills"],
    ["sync", "--providers=claude"], ["remove", "demo"],
    ["check", "--accept"], ["upstream"],
  ])("returns one JSON usage error without dispatch or writes: %j", async (...args) => {
    const before = readFileSync(join(dir, "quiver.lock"), "utf8");
    await invoke(...args, "--json");
    expect(jsonOutput()).toMatchObject({ ok: false, error: { code: "usage", message: expect.any(String) } });
    expect(process.exitCode).toBe(2);
    expect(init).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "quiver.lock"), "utf8")).toBe(before);
  });

  it.each([
    ["--json"], ["--json", "--yes"], ["--json", "--all"], ["--json", "--all", "--yes"],
  ])("delegates no-argument add selection to its handler: %j", async (...args) => {
    await invoke("add", ...args);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      positionals: [], all: args.includes("--all"), yes: args.includes("--yes"), name: null,
    }));
    expect(jsonOutput()).toEqual({ ok: true });
    expect(process.exitCode).toBe(0);
    expect(ui.selectGrouped).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
  });

  it.each([
    "github:acme/new/demo#feature/branch",
    `local:${join(tmpdir(), "custom skills")}`,
  ])("passes an explicit update source through unchanged: %s", async (source) => {
    installSkill();
    await invoke("update", "demo", `--source=${source}`, "--json");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ positionals: ["skill:demo"], source }));
    expect(jsonOutput()).toMatchObject({ ok: true });
    expect(process.exitCode).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
  });

  it("handles an uncaught command error as one JSON object", async () => {
    vi.mocked(add).mockRejectedValueOnce(new Error("source unavailable"));
    await invoke("add", "github:acme/skills/demo", "--json");
    expect(jsonOutput()).toEqual({ ok: false, error: { code: "command-failed", message: "source unavailable" } });
    expect(process.exitCode).toBe(2);
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
  });

  it("routes missing and malformed lockfiles through JSON error handling", async () => {
    rmSync(join(dir, "quiver.lock"));
    await invoke("list", "--json");
    expect(jsonOutput()).toMatchObject({ ok: false, error: { code: "no-lockfile" } });
    vi.mocked(console.log).mockClear();
    writeFileSync(join(dir, "quiver.lock"), "{");
    await invoke("inspect", "demo", "--json");
    expect(jsonOutput()).toMatchObject({ ok: false, error: { code: "command-failed" } });
  });

  it("normalizes unique names and rejects ambiguous installed names", async () => {
    installSkill();
    expect(resolveInstalledId("demo", lock)).toBe("skill:demo");
    expect(resolveInstalledId("skill:demo", lock)).toBe("skill:demo");
    await invoke("update", "demo", "--dry-run", "--json");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ positionals: ["skill:demo"] }));
    expect(jsonOutput()).toMatchObject({ ok: true, updated: ["skill:demo"] });
    expect(process.exitCode).toBe(0);
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
    lock.entries["command:demo"] = {
      type: "command", installedPath: "commands/demo.md", digest: `sha256:${"a".repeat(64)}`,
      source: { kind: "legacy", catalog: lock.catalog },
    };
    writeLockfile(dir, lock);
    expect(() => resolveInstalledId("demo", lock)).toThrow("command:demo, skill:demo");
    vi.mocked(console.log).mockClear();
    await invoke("update", "demo", "--json");
    expect(jsonOutput()).toMatchObject({ ok: false, error: { code: "ambiguous-id" } });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sync"], ["migrate", "--dry-run"], ["init", "--empty"],
    ["check", "--offline"], ["list"], ["providers", "--yes"],
  ])("never passively checks for updates for local operations: %j", async (...args) => {
    await invoke(...args);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
    expect(ui.selectGrouped).not.toHaveBeenCalled();
  });

  it("blocks dirty removal, including accepted edits, unless forced", async () => {
    const path = installSkill();
    writeFileSync(join(path, "SKILL.md"), "# Locally edited\n");
    const before = readFileSync(join(dir, "quiver.lock"), "utf8");
    await invoke("remove", "demo");
    expect(process.exitCode).toBe(1);
    expect(readFileSync(join(dir, "quiver.lock"), "utf8")).toBe(before);
    (lock.entries["skill:demo"] as SkillEntry).digest = treeDigest(path);
    writeLockfile(dir, lock);
    await invoke("remove", "demo");
    expect(process.exitCode).toBe(1);
    expect(existsSync(path)).toBe(true);
    process.exitCode = 0;
    await invoke("rm", "demo", "--force");
    expect(process.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(readLockfile(dir)!.entries).toEqual({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
  });

  it.each([["remove", "demo"], ["providers", "codex"]])("requires migration before shared mutations: %j", async (...args) => {
    const path = installSkill();
    const entry = lock.entries["skill:demo"] as SkillEntry;
    const { source: _source, installedPath, ...metadata } = entry;
    const v1 = JSON.stringify({ ...lock, version: 1, entries: { "skill:demo": { ...metadata, sourcePath: installedPath, pin: null } } });
    writeFileSync(join(dir, "quiver.lock"), v1);
    await invoke(...args);
    expect(process.exitCode).toBe(2);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining("migrate"));
    expect(readFileSync(join(dir, "quiver.lock"), "utf8")).toBe(v1);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
  });

  it("does not follow symlinked installed paths even with force", async () => {
    const path = installSkill();
    const outside = join(dir, "user-skill");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "# User content\n");
    rmSync(path, { recursive: true });
    symlinkSync(outside, path);
    const before = readFileSync(join(dir, "quiver.lock"), "utf8");
    await invoke("remove", "demo", "--force");
    expect(process.exitCode).toBe(2);
    expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("# User content\n");
    expect(readFileSync(join(dir, "quiver.lock"), "utf8")).toBe(before);
  });

  it("normalizes bare MCP names for toggles and acceptance without network calls", async () => {
    installMcp();
    await invoke("disable", "docs");
    expect(JSON.parse(readFileSync(join(dir, ".agents/config.local.json"), "utf8"))).toEqual({
      mcpServers: { docs: { enabled: false } },
    });
    await invoke("enable", "docs");
    expect(existsSync(join(dir, ".agents/config.local.json"))).toBe(false);
    await invoke("check", "docs", "--offline", "--accept");
    expect(readLockfile(dir)!.entries["mcp:docs"]!.source).toEqual(lock.entries["mcp:docs"]!.source);
    await invoke("inspect", "docs", "--json");
    expect(jsonOutput()).toMatchObject({ ok: true, name: "docs", enabled: true });
    expect(process.exitCode).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(notifier.checkForUpdate).not.toHaveBeenCalled();
  });

  it("protects edited MCP definitions and retains untracked definitions on forced removal", async () => {
    installMcp();
    const untracked = { transport: "http", url: "https://user.example/mcp" };
    writeFileSync(join(dir, ".agents/config.json"), JSON.stringify({
      mcpServers: { docs: { transport: "http", url: "https://edited.example/mcp" }, untracked },
    }));
    await invoke("remove", "docs");
    expect(process.exitCode).toBe(1);
    expect(readLockfile(dir)!.entries["mcp:docs"]).toBeDefined();
    process.exitCode = 0;
    await invoke("remove", "docs", "--force");
    expect(JSON.parse(readFileSync(join(dir, ".agents/config.json"), "utf8"))).toEqual({ mcpServers: { untracked } });
    expect(readLockfile(dir)!.entries).toEqual({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("removes a clean plugin using its installed path and combined config/content digest", async () => {
    mkdirSync(join(dir, ".agents/plugins"));
    const path = join(dir, ".agents/plugins/alias.ts");
    writeFileSync(path, "export default {};\n");
    const plugin = { provider: "opencode", sourcePath: "plugins/alias.ts", requires: [] };
    const digest = jsonDigest({ config: plugin, content: fileDigest(path) });
    lock.entries["plugin:alias"] = {
      type: "plugin", provider: "opencode", installedPath: plugin.sourcePath, requires: [], digest,
      source: { kind: "local", root: "/unavailable/source", path: "plugins/original.ts", digest },
    };
    writeFileSync(join(dir, ".agents/config.json"), JSON.stringify({ plugins: { alias: plugin }, shared: { keep: true } }));
    writeLockfile(dir, lock);
    await invoke("remove", "alias");
    expect(process.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".agents/config.json"), "utf8"))).toEqual({ shared: { keep: true } });
    expect(readLockfile(dir)!.entries).toEqual({});
  });

  it("requires explicit all for non-TTY catalog selection", async () => {
    const catalog = {
      skills: [{ name: "unresolved", group: "general", frontmatter: { name: null, description: null, version: null } }],
      commands: [], mcp: [], plugins: [],
    };
    await expect(selectFromCatalog(catalog, { interactive: true, providers: ["claude"] })).rejects.toThrow("--all");
    await expect(selectFromCatalog(catalog, { interactive: false, providers: ["claude"] })).resolves.toEqual({
      skills: ["unresolved"], commands: [], mcp: [], plugins: [],
    });
    expect(ui.selectGrouped).not.toHaveBeenCalled();
  });
});
