export const LOCKFILE_VERSION = 1 as const;
export const LOCKFILE_NAME = "quiver.lock";

export type EntryType = "skill" | "command" | "mcp";

export interface CatalogRef {
  /** e.g. "local:template/.agents" now, "github:owner/repo" later. */
  source: string;
  /** Branch/tag for remote catalogs; null for local. */
  ref: string | null;
  /** Resolved commit SHA for remote catalogs; null for local. */
  resolved: string | null;
  fetchedAt: string;
}

export interface SkillEntry {
  type: "skill";
  sourcePath: string;
  /** sha256 of the whole skill directory tree. */
  digest: string;
  /** null = follow catalog HEAD; "tag:v1" / "sha:abc" once remote pinning lands. */
  pin: string | null;
  frontmatter: {
    name: string | null;
    description: string | null;
    version: string | null;
  };
}

export interface CommandEntry {
  type: "command";
  sourcePath: string;
  digest: string;
}

export interface McpToolSnapshot {
  /** Plain-text description, kept readable for poisoning diffs. */
  description: string;
  /** sha256 of the canonicalised inputSchema. */
  inputSchemaHash: string;
}

export interface McpEntry {
  type: "mcp";
  transport: "http" | "stdio";
  /** sha256 of the server definition in config.json. */
  configDigest: string;
  /** tools/list snapshot, keyed by tool name; null until introspected. */
  tools: Record<string, McpToolSnapshot> | null;
  toolsFetchedAt: string | null;
}

export type LockEntry = SkillEntry | CommandEntry | McpEntry;

export interface Lockfile {
  version: typeof LOCKFILE_VERSION;
  catalog: CatalogRef;
  entries: Record<string, LockEntry>;
}

export const entryId = (type: EntryType, name: string): string =>
  `${type}:${name}`;

export const parseEntryId = (
  id: string,
): { type: EntryType; name: string } | null => {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  const type = id.slice(0, idx);
  const name = id.slice(idx + 1);
  if (type !== "skill" && type !== "command" && type !== "mcp") return null;
  if (!name) return null;
  return { type, name };
};
