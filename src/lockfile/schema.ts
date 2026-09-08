export const LOCKFILE_VERSION = 2 as const;
export const LOCKFILE_NAME = "quiver.lock";
export type LockfileVersion = 1 | typeof LOCKFILE_VERSION;

export type EntryType = "skill" | "command" | "mcp" | "plugin";

export const PROVIDERS = ["claude", "opencode", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (v: string): v is Provider =>
  (PROVIDERS as readonly string[]).includes(v);

export interface CatalogRef {
  /** Discovery catalog only; installed entries carry their own provenance. */
  source: string;
  /** Branch/tag for remote catalogs; null for local. */
  ref: string | null;
  /** Resolved commit SHA for remote catalogs; null for local. */
  resolved: string | null;
  fetchedAt: string;
}

export interface GithubEntrySource {
  kind: "github";
  repo: string;
  path: string;
  /** null tracks the default branch; a full commit SHA is immutable. */
  ref: string | null;
  commit: string;
  /** Source baseline, independent of locally accepted changes. */
  digest: string;
}

export interface LocalEntrySource {
  kind: "local";
  /** Absolute root of an explicitly selected writable local source. */
  root: string;
  /** Relative to root; empty when root is the entry itself. */
  path: string;
  digest: string;
}

export interface LegacyEntrySource {
  kind: "legacy";
  /** Unverified V1 provenance; never inferred from current catalog content. */
  catalog: CatalogRef;
  sourcePath?: string;
  pin?: string | null;
}

export type EntrySource =
  | GithubEntrySource
  | LocalEntrySource
  | LegacyEntrySource;

export interface SkillEntry {
  type: "skill";
  /** Path relative to the installed .agents root. */
  installedPath: string;
  source: EntrySource;
  /** Accepted local sha256 of the whole skill directory tree. */
  digest: string;
  frontmatter: {
    name: string | null;
    description: string | null;
    version: string | null;
  };
}

export interface CommandEntry {
  type: "command";
  installedPath: string;
  source: EntrySource;
  digest: string;
}

export interface McpToolSnapshot {
  /** Plain-text description, kept readable for poisoning diffs. */
  description: string;
  /** sha256 of the canonicalised inputSchema. */
  inputSchemaHash: string;
  /** Rough context cost (chars/4 over name+description+schema); absent in old lockfiles. */
  tokens?: number;
}

export interface McpEntry {
  type: "mcp";
  source: EntrySource;
  transport: "http" | "stdio";
  /** Accepted local sha256 of the server definition in config.json. */
  configDigest: string;
  /** tools/list snapshot, keyed by tool name; null until introspected. */
  tools: Record<string, McpToolSnapshot> | null;
  toolsFetchedAt: string | null;
  /** True once the server rejected unauthenticated introspection (OAuth). */
  authRequired?: boolean;
}

export interface PluginEntry {
  type: "plugin";
  provider: "opencode";
  installedPath: string;
  source: EntrySource;
  digest: string;
  requires: string[];
}

export type LockEntry = SkillEntry | CommandEntry | McpEntry | PluginEntry;

export interface Lockfile {
  /** V1 entries are normalized in memory but must be explicitly migrated. */
  version: LockfileVersion;
  catalog: CatalogRef;
  /** Tools to generate configs for; null/absent = all (backwards compatible). */
  providers?: Provider[] | null;
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
  if (
    type !== "skill" &&
    type !== "command" &&
    type !== "mcp" &&
    type !== "plugin"
  ) {
    return null;
  }
  if (
    !name.trim() ||
    /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) ||
    /[. ]$/.test(name) ||
    ["__proto__", "constructor", "prototype"].includes(name)
  ) {
    return null;
  }
  return { type, name };
};
