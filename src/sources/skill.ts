import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { CatalogSkill } from "../catalog/discover.js";
import { treeDigest } from "../catalog/digest.js";
import { readFrontmatter } from "../catalog/frontmatter.js";

export const loadSkillDirectory = (
  absDir: string,
  name: string,
  installedPath: string,
): CatalogSkill => {
  const safeSegment = (part: string): boolean =>
    !!part && part !== "." && part !== ".." &&
    !/[\\/\x00-\x1f\x7f<>:"|?*]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
  if (!safeSegment(name)) {
    throw new Error("Invalid skill name: expected a safe single path segment");
  }
  const parts = installedPath.split(/[\\/]/);
  if (
    parts.length < 2 || parts[0] !== "skills" ||
    parts.at(-1) !== name || !parts.every(safeSegment)
  ) {
    throw new Error(
      "Invalid skill installation path: expected skills/[group/]name",
    );
  }
  if (!isAbsolute(absDir) || !lstatSync(absDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Skill source must be an absolute, regular directory");
  }
  const skillFile = resolve(absDir, "SKILL.md");
  const stat = lstatSync(skillFile, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.nlink !== 1) {
    throw new Error("Skill source must contain a regular root SKILL.md");
  }
  const validate = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!safeSegment(entry.name)) throw new Error("Unsafe skill resource path");
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "SKILL.md") throw new Error("SKILL.md must not be a directory");
        validate(path);
      } else if (!entry.isFile()) {
        throw new Error(
          "Unsafe skill resource: only regular files and directories are allowed",
        );
      }
    }
  };
  validate(absDir);
  const digest = treeDigest(absDir);
  const fm = readFrontmatter(readFileSync(skillFile, "utf8"));
  return {
    name, group: parts.length > 2 ? parts[1]! : "general",
    sourcePath: installedPath, absDir, digest,
    frontmatter: {
      name: fm["name"] ?? null,
      description: fm["description"] ?? null,
      version: fm["version"] ?? null,
    },
  };
};
