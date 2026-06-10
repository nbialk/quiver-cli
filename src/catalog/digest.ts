import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const sha256 = (data: string | Buffer): string =>
  "sha256:" + createHash("sha256").update(data).digest("hex");

export const fileDigest = (path: string): string => sha256(readFileSync(path));

// Hash a directory tree deterministically: sorted relative paths, each combined
// with the sha256 of its contents. Captures SKILL.md plus scripts/assets, so any
// behavioural change in a skill shows up as a digest change.
export const treeDigest = (dir: string): string => {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);

  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const rel = relative(dir, file);
    hash.update(rel);
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(file)).digest());
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
