import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const sha256 = (data: string | Buffer): string =>
  "sha256:" + createHash("sha256").update(data).digest("hex");

export const fileDigest = (path: string): string => sha256(readFileSync(path));

// Hash a directory tree deterministically: sorted relative paths, each combined
// with the sha256 of its contents. Captures SKILL.md plus scripts/assets, so any
// behavioural change in a skill shows up as a digest change. Modes are excluded.
// Unsafe entries throw, including during local drift checks; never omit links.
export const treeDigest = (dir: string): string => {
  const files: string[] = [];
  const walk = (current: string): void => {
    const stat = lstatSync(current);
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) walk(resolve(current, name));
    } else if (stat.isFile() && stat.nlink === 1) {
      files.push(relative(dir, current).split(sep).join("/"));
    } else {
      throw new Error(
        `Unsafe tree entry (links and special files are not allowed): ${current}`,
      );
    }
  };
  if (!lstatSync(dir).isDirectory()) {
    throw new Error(`Tree root must be a regular directory: ${dir}`);
  }
  walk(dir);

  const hash = createHash("sha256");
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(
      createHash("sha256").update(readFileSync(resolve(dir, rel))).digest(),
    );
    hash.update("\0");
  }
  return "sha256:" + hash.digest("hex");
};

// Stable hash of an arbitrary JSON value (sorted keys) - used for MCP server
// definitions and inputSchema canonicalisation.
export const jsonDigest = (value: unknown): string =>
  sha256(canonicalJson(value));

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalJson((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
};

export const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
