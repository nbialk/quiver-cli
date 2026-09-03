import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Catalog } from "../src/catalog/discover.js";
import {
  materializeCatalog,
  removeArtifact,
} from "../src/catalog/materialize.js";

const roots: string[] = [];

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "quiver-materialize-"));
  roots.push(root);
  return root;
};

const catalogWithSkill = (sourcePath: string, absDir: string): Catalog => ({
  config: {},
  configPath: join(absDir, "config.json"),
  skills: [
    {
      name: "unsafe",
      group: "general",
      sourcePath,
      absDir,
      digest: "digest",
      frontmatter: { name: null, description: null, version: null },
    },
  ],
  commands: [],
  mcp: [],
  plugins: [],
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("catalog materialization containment", () => {
  it.each(["../outside", "/tmp/outside", "C:\\outside"])(
    "rejects selected source path %s before mutation",
    (sourcePath) => {
      const targetRoot = tempRoot();
      const sourceRoot = tempRoot();
      mkdirSync(join(sourceRoot, "skill"));
      writeFileSync(join(sourceRoot, "skill/SKILL.md"), "# Skill\n");

      expect(() =>
        materializeCatalog(
          targetRoot,
          { source: "local:test", root: sourceRoot },
          catalogWithSkill(sourcePath, join(sourceRoot, "skill")),
          { skills: ["unsafe"], commands: [], mcp: [], plugins: [] },
        ),
      ).toThrow(/sourcePath.*(beneath|escapes)/);
      expect(existsSync(join(targetRoot, ".agents"))).toBe(false);
    },
  );

  it.each(["../outside", "/tmp/outside", "C:\\outside"])(
    "does not remove lockfile source path %s",
    (sourcePath) => {
      const targetRoot = tempRoot();
      const outside = join(targetRoot, "outside");
      writeFileSync(outside, "keep\n");

      expect(() => removeArtifact(targetRoot, sourcePath)).toThrow(
        /Lockfile sourcePath/,
      );
      expect(existsSync(outside)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked .agents directory before writing",
    () => {
      const targetRoot = tempRoot();
      const outside = tempRoot();
      symlinkSync(outside, join(targetRoot, ".agents"), "dir");

      expect(() =>
        materializeCatalog(
          targetRoot,
          { source: "local:test", root: outside },
          { ...catalogWithSkill("skills/safe", outside), skills: [] },
          { skills: [], commands: [], mcp: [], plugins: [] },
        ),
      ).toThrow(/symlinked parent/);
      expect(existsSync(join(outside, "config.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not remove through a symlinked .agents directory",
    () => {
      const targetRoot = tempRoot();
      const outside = tempRoot();
      writeFileSync(join(outside, "keep"), "keep\n");
      symlinkSync(outside, join(targetRoot, ".agents"), "dir");

      expect(() => removeArtifact(targetRoot, "keep")).toThrow(
        /symlinked parent/,
      );
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep\n");
    },
  );
});
