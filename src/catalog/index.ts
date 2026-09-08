import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseEntryId } from "../lockfile/schema.js";
import { assertSafeMutationPath } from "../path.js";
import { parseGithubSource } from "../sources/github.js";
import type { Catalog } from "./discover.js";

export interface SkillReference {
  name: string;
  source: string;
  group: string;
  frontmatter: {
    name: string;
    description: string | null;
    version: null;
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const readSkillReferences = (
  root: string,
  catalog: Catalog,
): SkillReference[] => {
  const path = resolve(root, "catalog.json");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  assertSafeMutationPath(root, path, "Catalog index");
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("Invalid catalog.json: expected a regular file.");
  }

  let index: unknown;
  try {
    index = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid catalog.json: expected valid JSON.");
  }
  if (
    !object(index) || index.version !== 1 || !object(index.skills) ||
    Object.keys(index).some((key) => key !== "version" && key !== "skills")
  ) {
    throw new Error("Invalid catalog.json: expected { version: 1, skills: { name: { source, group?, description? } } }.");
  }

  const seen = new Set(catalog.skills.map((skill) => skill.name.toLowerCase()));
  return Object.entries(index.skills).map(([name, value]) => {
    if (
      !parseEntryId(`skill:${name}`) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ) {
      throw new Error(`Invalid catalog.json skill name "${name}": expected a safe single path segment.`);
    }
    if (seen.has(name.toLowerCase())) {
      throw new Error(`Duplicate skill name "${name}" in catalog.json or catalog skills (case-insensitive).`);
    }
    seen.add(name.toLowerCase());
    if (
      !object(value) || typeof value.source !== "string" ||
      Object.keys(value).some((key) => !["source", "group", "description"].includes(key)) ||
      (value.group !== undefined && (typeof value.group !== "string" || !value.group.trim() || /[\x00-\x1f\x7f]/.test(value.group))) ||
      (value.description !== undefined && value.description !== null && typeof value.description !== "string")
    ) {
      throw new Error(`Invalid catalog.json skill "${name}": expected source, optional group and description only; provenance belongs in quiver.lock.`);
    }
    try {
      parseGithubSource(value.source);
    } catch (error) {
      throw new Error(`Invalid catalog.json skill "${name}" source: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      name,
      source: value.source,
      group: value.group ?? "general",
      frontmatter: { name, description: value.description ?? null, version: null },
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
};
