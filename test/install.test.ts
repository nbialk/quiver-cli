import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { treeDigest } from "../src/catalog/digest.js";
import { loadCatalog } from "../src/catalog/discover.js";
import { installedDigest, installPreparedEntry } from "../src/commands/install.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";
import { prepareCatalogEntry, prepareDirectSkill, prepareEntryUpdate } from "../src/sources/entry.js";

let root: string;
let repoDir: string;
let sourceDir: string;

const write = (base: string, path: string, content: string | Buffer): void => {
  fs.mkdirSync(dirname(join(base, path)), { recursive: true });
  fs.writeFileSync(join(base, path), content);
};

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

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "quiver-install-"));
  repoDir = join(root, "repo");
  sourceDir = join(root, "source");
  write(repoDir, ".agents/config.json", "{}\n");
  write(sourceDir, "SKILL.md", "---\nname: upstream-name\n---\nOriginal skill\n");
  write(sourceDir, "assets/data.bin", Buffer.from([0, 255, 42]));
  const lock = emptyLockfile("github:unavailable/catalog");
  lock.providers = ["opencode"];
  writeLockfile(repoDir, lock);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("installPreparedEntry", () => {
  it("installs a real source and all resources under its alias, committing only that entry", async () => {
    write(sourceDir, "scripts/run.ts", "throw new Error('Must not execute');\n");
    write(sourceDir, "references/guide.md", "Resource documentation\n");
    write(sourceDir, "config.json", "This is a skill resource, not repository config\n");
    write(repoDir, ".agents/skills/sibling/SKILL.md", "Authored sibling\n");
    const config = '{"opencode":{"model":"local/model"},"mcpServers":{"local":{"transport":"stdio","command":"never-run"}}}\n';
    write(repoDir, ".agents/config.json", config);
    const lock = readLockfile(repoDir)!;
    const catalog = structuredClone(lock.catalog);
    const prepared = await prepareDirectSkill(`local:${sourceDir}`, "my-alias");

    installPreparedEntry(repoDir, lock, prepared);

    expect(readLockfile(repoDir)).toEqual(lock);
    expect(lock.entries).toEqual({ "skill:my-alias": prepared.entry });
    expect(lock.catalog).toEqual(catalog);
    expect(prepared.entry).toMatchObject({
      installedPath: "skills/my-alias", frontmatter: { name: "upstream-name" },
      source: { kind: "local", root: sourceDir, path: "", digest: treeDigest(sourceDir) },
    });
    expect(snapshot(join(repoDir, ".agents/skills/my-alias"))).toEqual(snapshot(sourceDir));
    expect(installedDigest(repoDir, prepared.id, prepared.entry, lock)).toBe(treeDigest(sourceDir));
    expect(fs.readFileSync(join(repoDir, ".agents/config.json"), "utf8")).toBe(config);
    expect(fs.readFileSync(join(repoDir, ".agents/skills/sibling/SKILL.md"), "utf8")).toBe("Authored sibling\n");
    expect(fs.readdirSync(repoDir).sort()).toEqual([".agents", "quiver.lock"]);
  });

  it("cleans a partially copied stage after source IO failure without changing installed bytes or either lock", async () => {
    const lock = readLockfile(repoDir)!;
    const original = await prepareDirectSkill(`local:${sourceDir}`, "demo");
    installPreparedEntry(repoDir, lock, original);
    write(sourceDir, "SKILL.md", "Updated skill\n");
    const prepared = await prepareEntryUpdate(original.id, original.entry);
    const digest = installedDigest(repoDir, original.id, original.entry, lock);
    const before = snapshot(repoDir);
    const lockBefore = structuredClone(lock);
    const copy = vi.spyOn(fs, "cpSync").mockImplementationOnce((from, to) => {
      fs.mkdirSync(String(to), { recursive: true });
      fs.copyFileSync(join(String(from), "SKILL.md"), join(String(to), "SKILL.md"));
      throw Object.assign(new Error("Injected source copy failure"), { code: "ENOSPC" });
    });
    syncBuiltinESMExports();

    expect(() => installPreparedEntry(repoDir, lock, prepared, digest)).toThrow("Injected source copy failure");

    expect(copy).toHaveBeenCalledTimes(1);
    expect(snapshot(repoDir)).toEqual(before);
    expect(lock).toEqual(lockBefore);
    expect(readLockfile(repoDir)).toEqual(lockBefore);
  });

  it("rolls back both a plugin artifact and shared config when the real atomic lock write fails", async () => {
    const config = {
      shared: { local: true }, opencode: { model: "local/model" },
      mcpServers: { sibling: { transport: "stdio", command: "never-run" } },
    };
    write(repoDir, ".agents/config.json", JSON.stringify(config, null, 4) + "\n");
    write(sourceDir, "plugins/demo.ts", "export const version = 1;\n");
    write(sourceDir, "config.json", JSON.stringify({ plugins: {
      demo: { provider: "opencode", sourcePath: "plugins/demo.ts", requires: [] },
    } }));
    const source = { source: `local:${sourceDir}`, root: sourceDir };
    const original = await prepareCatalogEntry(source, loadCatalog(source), "plugin:demo");
    const lock = readLockfile(repoDir)!;
    installPreparedEntry(repoDir, lock, original);
    write(sourceDir, "plugins/demo.ts", "export const version = 2;\n");
    write(sourceDir, "config.json", JSON.stringify({ plugins: {
      demo: { provider: "opencode", sourcePath: "plugins/demo.ts", requires: ["node"] },
    } }));
    const prepared = await prepareEntryUpdate(original.id, original.entry);
    const digest = installedDigest(repoDir, original.id, original.entry, lock);
    const before = snapshot(repoDir);
    const lockBefore = structuredClone(lock);
    const writeFile = fs.writeFileSync;
    let failed = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (typeof file === "number") {
        failed = true;
        expect(fs.readFileSync(join(repoDir, ".agents/plugins/demo.ts"), "utf8")).toBe("export const version = 2;\n");
        expect(JSON.parse(fs.readFileSync(join(repoDir, ".agents/config.json"), "utf8")).plugins.demo.requires).toEqual(["node"]);
        throw Object.assign(new Error("Injected lock write failure"), { code: "EIO" });
      }
      writeFile(file, data, options);
    });
    syncBuiltinESMExports();

    expect(() => installPreparedEntry(repoDir, lock, prepared, digest)).toThrow("Injected lock write failure");

    expect(failed).toBe(true);
    expect(snapshot(repoDir)).toEqual(before);
    expect(lock).toEqual(lockBefore);
    expect(readLockfile(repoDir)).toEqual(lockBefore);
  });

  it.each([
    ["an unmanaged destination without SKILL.md", "skills/demo/notes.txt"],
    ["an unmanaged nested alias", "skills/custom/demo/SKILL.md"],
  ])("does not clobber %s", async (_label, path) => {
    write(repoDir, `.agents/${path}`, "Authored local content\n");
    const lock = readLockfile(repoDir)!;
    const prepared = await prepareDirectSkill(`local:${sourceDir}`, "demo");
    const before = snapshot(repoDir);

    expect(() => installPreparedEntry(repoDir, lock, prepared)).toThrow(/conflicts with existing|already exists/);

    expect(snapshot(repoDir)).toEqual(before);
    expect(lock.entries).toEqual({});
    expect(readLockfile(repoDir)).toEqual(lock);
  });

  it("rejects a symlinked installed parent without touching the external tree", async () => {
    const external = join(root, "external");
    write(external, "demo/SKILL.md", "External authored skill\n");
    fs.symlinkSync(external, join(repoDir, ".agents/skills"), "dir");
    const lock = readLockfile(repoDir)!;
    const prepared = await prepareDirectSkill(`local:${sourceDir}`, "demo");
    const before = snapshot(repoDir);
    const externalBefore = snapshot(external);

    expect(() => installPreparedEntry(repoDir, lock, prepared)).toThrow(/symlinked/);

    expect(snapshot(repoDir)).toEqual(before);
    expect(snapshot(external)).toEqual(externalBefore);
    expect(lock.entries).toEqual({});
  });
});
