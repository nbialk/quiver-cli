import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { treeDigest } from "../src/catalog/digest.js";
import { loadSkillDirectory } from "../src/sources/skill.js";

let repo: string;
let dir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "quiver-skill-source-"));
  dir = join(repo, "vendor/upstream-name");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# Cleanup\nInstructions without frontmatter.\n");
  writeFileSync(join(dir, "scripts/run.sh"), "exit 1\n");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("loadSkillDirectory", () => {
  it("loads optional-frontmatter skills with independent installation names and paths", () => {
    expect(loadSkillDirectory(dir, "cleanup", "skills/cleanup")).toEqual({
      name: "cleanup", group: "general", sourcePath: "skills/cleanup", absDir: dir,
      digest: treeDigest(dir), frontmatter: { name: null, description: null, version: null },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads optional YAML scalars without using frontmatter names as installation aliases", () => {
    writeFileSync(join(dir, "SKILL.md"), "---\nname: upstream-name\ndescription: >\n  Cleans code\n  and resources.\nversion: '2.1'\nmetadata:\n  name: ignored\n---\nBody\n");
    expect(loadSkillDirectory(dir, "cleanup", "skills/code/cleanup")).toMatchObject({
      name: "cleanup", group: "code", sourcePath: "skills/code/cleanup", absDir: dir,
      frontmatter: { name: "upstream-name", description: "Cleans code and resources.", version: "2.1" },
    });
  });

  it("preserves existing first-level skill grouping for deeper installation paths", () => {
    expect(loadSkillDirectory(dir, "cleanup", "skills/code/tools/cleanup").group).toBe("code");
  });

  it("hashes nested resources, but never reads repository/provider configs or runs scripts", () => {
    writeFileSync(join(repo, "config.json"), "invalid JSON");
    writeFileSync(join(repo, "opencode.json"), "invalid JSON");
    writeFileSync(join(repo, "package.json"), "invalid JSON");
    const original = loadSkillDirectory(dir, "cleanup", "skills/cleanup");
    mkdirSync(join(dir, "assets/nested"), { recursive: true });
    writeFileSync(join(dir, "assets/nested/example.bin"), Buffer.from([0, 255, 1]));
    const changed = loadSkillDirectory(dir, "cleanup", "skills/cleanup");
    expect(changed.digest).not.toBe(original.digest);
    writeFileSync(join(repo, "config.json"), '{"plugins":{"unsafe":"run me"}}');
    expect(loadSkillDirectory(dir, "cleanup", "skills/cleanup").digest).toBe(changed.digest);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", ".", "..", "../outside", "/absolute", "a/b", "a\\b", "C:drive", "bad\0name", "bad\nname", "name.", "name ", "CON", "nul.md"])(
    "rejects unsafe installation name %s", (name) => {
      expect(() => loadSkillDirectory(dir, name, `skills/${name}`)).toThrow(/Invalid skill name/);
    },
  );

  it("accepts migrated Windows installation paths without changing their spelling", () => {
    expect(loadSkillDirectory(dir, "cleanup", "skills\\code\\cleanup")).toMatchObject({
      sourcePath: "skills\\code\\cleanup", group: "code", digest: treeDigest(dir),
    });
  });

  it.each(["cleanup", "/skills/cleanup", "skills/../cleanup", "skills/./cleanup", "skills//cleanup", "skills\\..\\cleanup", "skills/cleanup/", "commands/cleanup", "skills/different", "skills/C:drive/cleanup"])(
    "rejects unsafe or mismatched installation path %s", (path) => {
      expect(() => loadSkillDirectory(dir, "cleanup", path)).toThrow(/Invalid skill installation path/);
    },
  );

  it("requires an absolute source directory", () => {
    expect(() => loadSkillDirectory("vendor/upstream-name", "cleanup", "skills/cleanup")).toThrow(/absolute, regular directory/);
  });

  it.each(["missing", "directory", "symlink", "hardlink"])("requires a regular root SKILL.md, not %s", (kind) => {
    rmSync(join(dir, "SKILL.md"));
    if (kind === "directory") mkdirSync(join(dir, "SKILL.md"));
    if (kind === "symlink") symlinkSync("scripts/run.sh", join(dir, "SKILL.md"));
    if (kind === "hardlink") linkSync(join(dir, "scripts/run.sh"), join(dir, "SKILL.md"));
    expect(() => loadSkillDirectory(dir, "cleanup", "skills/cleanup")).toThrow(/regular root SKILL.md/);
  });

  it("does not discover a nested skill when the selected root has no SKILL.md", () => {
    expect(() => loadSkillDirectory(repo, "cleanup", "skills/cleanup")).toThrow(/regular root SKILL.md/);
  });

  it("rejects a directory named SKILL.md anywhere in resources", () => {
    mkdirSync(join(dir, "scripts/SKILL.md"));
    expect(() => loadSkillDirectory(dir, "cleanup", "skills/cleanup")).toThrow(/SKILL.md must not be a directory/);
  });

  it.each(["internal file", "internal directory", "escape", "dangling"])("rejects %s resource links", (kind) => {
    const target = kind === "internal file" ? "../SKILL.md" : kind === "internal directory" ? ".." : kind === "escape" ? repo : "missing";
    symlinkSync(target, join(dir, "scripts/link"));
    expect(() => loadSkillDirectory(dir, "cleanup", "skills/cleanup")).toThrow(/Unsafe skill resource/);
  });

  it("rejects a symlinked source root", () => {
    symlinkSync(dir, join(repo, "alias"));
    expect(() => loadSkillDirectory(join(repo, "alias"), "cleanup", "skills/cleanup")).toThrow(/absolute, regular directory/);
  });

  it("rejects hardlinked resources", () => {
    linkSync(join(dir, "scripts/run.sh"), join(dir, "scripts/alias.sh"));
    expect(() => loadSkillDirectory(dir, "cleanup", "skills/cleanup")).toThrow(/Unsafe tree entry/);
  });

  it.skipIf(process.platform === "win32")("rejects portable-path aliases in nested resources", () => {
    writeFileSync(join(dir, "scripts/..\\escape"), "Unsafe\n");
    expect(() => loadSkillDirectory(dir, "cleanup", "skills/cleanup")).toThrow(/Unsafe skill resource path/);
  });

  it.skipIf(process.platform === "win32")("rejects special resources without reading them", () => {
    expect(spawnSync("mkfifo", [join(dir, "scripts/fifo")]).status).toBe(0);
    expect(() => loadSkillDirectory(dir, "cleanup", "skills/cleanup")).toThrow(/Unsafe skill resource/);
  });
});
