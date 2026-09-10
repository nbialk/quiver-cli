import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";

import { assertSafeMutationPath } from "../path.js";
import { validatePluginRequirements } from "../plugins/requirements.js";
import {
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  isProvider,
  parseEntryId,
  type CatalogRef,
  type EntrySource,
  type LockEntry,
  type Lockfile,
} from "./schema.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/i;

const invalid = (field: string, expected: string): never => {
  throw new Error(
    `Invalid ${LOCKFILE_NAME}: ${field} ${expected}. Fix this field or restore a valid lockfile from version control.`,
  );
};

const object = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(field, "must be an object");
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, field: string): string => {
  if (typeof value !== "string") return invalid(field, "must be a string");
  return value;
};

const nonemptyString = (value: unknown, field: string): string => {
  const text = string(value, field);
  if (!text.trim() || /[\u0000-\u001f\u007f]/.test(text)) {
    return invalid(field, "must be a nonempty string without control characters");
  }
  return text;
};

const digest = (value: unknown, field: string): void => {
  if (!DIGEST.test(string(value, field))) {
    invalid(
      field,
      'must be "sha256:" followed by 64 lowercase hexadecimal characters',
    );
  }
};

const relativePath = (value: unknown, field: string, allowEmpty = false): void => {
  const path = string(value, field);
  if (allowEmpty && path === "") return;
  const parts = path.split(/[\\/]/);
  if (
    !path.trim() ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /[<>:"|?*\u0000-\u001f\u007f]/.test(path) ||
    !parts.some((part) => part && part !== ".") ||
    parts.some((part) => part === ".." || (part !== "." && /[. ]$/.test(part)))
  ) {
    invalid(
      field,
      "must be a relative path beneath its root without '..', absolute paths, or unsafe characters",
    );
  }
};

const catalogRef = (value: unknown, field: string): CatalogRef => {
  const catalog = object(value, field);
  nonemptyString(catalog.source, `${field}.source`);
  if (catalog.ref !== null) nonemptyString(catalog.ref, `${field}.ref`);
  if (
    catalog.resolved !== null &&
    !COMMIT.test(string(catalog.resolved, `${field}.resolved`))
  ) {
    invalid(`${field}.resolved`, "must be null or a full 40-character commit SHA");
  }
  nonemptyString(catalog.fetchedAt, `${field}.fetchedAt`);
  return { ...catalog } as unknown as CatalogRef;
};

const entrySource = (value: unknown, field: string): EntrySource => {
  const source = object(value, field);
  switch (source.kind) {
    case "github": {
      const repo = string(source.repo, `${field}.repo`);
      if (
        !/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repo) ||
        [".", ".."].includes(repo.split("/")[1]!)
      ) {
        invalid(`${field}.repo`, 'must be a GitHub "owner/repo" name');
      }
      relativePath(source.path, `${field}.path`, true);
      if (source.ref !== null) nonemptyString(source.ref, `${field}.ref`);
      const commit = string(source.commit, `${field}.commit`);
      if (!COMMIT.test(commit)) {
        invalid(`${field}.commit`, "must be a full 40-character commit SHA");
      }
      if (
        typeof source.ref === "string" &&
        COMMIT.test(source.ref) &&
        source.ref.toLowerCase() !== commit.toLowerCase()
      ) {
        invalid(`${field}.commit`, "must match the immutable full-SHA ref");
      }
      digest(source.digest, `${field}.digest`);
      break;
    }
    case "local": {
      const root = nonemptyString(source.root, `${field}.root`);
      if (!isAbsolute(root) && !win32.isAbsolute(root)) {
        invalid(`${field}.root`, "must be an absolute local path");
      }
      relativePath(source.path, `${field}.path`, true);
      digest(source.digest, `${field}.digest`);
      break;
    }
    case "legacy":
      catalogRef(source.catalog, `${field}.catalog`);
      if (source.sourcePath !== undefined) {
        relativePath(source.sourcePath, `${field}.sourcePath`);
      }
      if (source.pin !== undefined && source.pin !== null) {
        string(source.pin, `${field}.pin`);
      }
      break;
    default:
      invalid(`${field}.kind`, 'must be "github", "local", or "legacy"');
  }
  return { ...source } as unknown as EntrySource;
};

const parseLockfile = (value: unknown): Lockfile => {
  const lock = object(value, "lockfile");
  if (lock.version !== 1 && lock.version !== LOCKFILE_VERSION) {
    throw new Error(
      `Unsupported ${LOCKFILE_NAME} version ${JSON.stringify(lock.version)}; supported versions are 1 and ${LOCKFILE_VERSION}. Upgrade quiver-cli for newer lockfiles, or restore a valid lockfile.`,
    );
  }
  const catalog = catalogRef(lock.catalog, "catalog");
  if (lock.providers !== undefined && lock.providers !== null) {
    if (
      !Array.isArray(lock.providers) ||
      lock.providers.some((p) => typeof p !== "string" || !isProvider(p))
    ) {
      invalid(
        "providers",
        'must be null or an array containing only "claude", "opencode", or "codex"',
      );
    }
  }
  const entries = Object.entries(object(lock.entries, "entries")).map(([id, value]) => {
    const field = `entries[${JSON.stringify(id)}]`;
    const parsed = parseEntryId(id);
    if (!parsed) {
      return invalid(field, "must have a valid type:name id with a safe single-segment name");
    }
    const entry = { ...object(value, field) };
    if (entry.type !== parsed.type) {
      invalid(`${field}.type`, "must match its entry id");
    }
    if ("modified" in entry) {
      invalid(`${field}.modified`, "must not be stored; local drift is computed from digests");
    }

    let source: EntrySource;
    if (lock.version === 1) {
      source = {
        kind: "legacy",
        catalog: { ...catalog },
        ...(entry.type !== "mcp"
          ? { sourcePath: string(entry.sourcePath, `${field}.sourcePath`) }
          : {}),
      };
      if (entry.type === "skill" && entry.pin !== undefined) {
        if (entry.pin !== null) string(entry.pin, `${field}.pin`);
        source.pin = entry.pin as string | null;
      }
    } else {
      for (const key of ["sourcePath", "pin"]) {
        if (key in entry) {
          invalid(`${field}.${key}`, "is a V1 field; use installedPath and source provenance in V2");
        }
      }
      source = entrySource(entry.source, `${field}.source`);
    }

    const pathKey = lock.version === 1 ? "sourcePath" : "installedPath";
    if (entry.type !== "mcp") {
      relativePath(entry[pathKey], `${field}.${pathKey}`);
      digest(entry.digest, `${field}.digest`);
    }
    switch (entry.type) {
      case "skill": {
        const frontmatter = { ...object(entry.frontmatter, `${field}.frontmatter`) };
        // The first shipped V1 schema did not record frontmatter.version.
        if (lock.version === 1 && frontmatter.version === undefined) {
          frontmatter.version = null;
        }
        for (const key of ["name", "description", "version"]) {
          if (frontmatter[key] !== null) {
            string(frontmatter[key], `${field}.frontmatter.${key}`);
          }
        }
        entry.frontmatter = frontmatter;
        break;
      }
      case "command":
        break;
      case "plugin":
        if (entry.provider !== "opencode") {
          invalid(`${field}.provider`, 'must be "opencode"');
        }
        validatePluginRequirements(entry.requires, `${field}.requires`);
        break;
      case "mcp":
        if (entry.transport !== "http" && entry.transport !== "stdio") {
          invalid(`${field}.transport`, 'must be "http" or "stdio"');
        }
        digest(entry.configDigest, `${field}.configDigest`);
        if (entry.toolsFetchedAt !== null) {
          nonemptyString(entry.toolsFetchedAt, `${field}.toolsFetchedAt`);
        }
        if (entry.authRequired !== undefined && typeof entry.authRequired !== "boolean") {
          invalid(`${field}.authRequired`, "must be a boolean when present");
        }
        if (entry.tools !== null) {
          for (const [name, value] of Object.entries(object(entry.tools, `${field}.tools`))) {
            const toolField = `${field}.tools[${JSON.stringify(name)}]`;
            nonemptyString(name, `${field}.tools key`);
            const tool = object(value, toolField);
            string(tool.description, `${toolField}.description`);
            digest(tool.inputSchemaHash, `${toolField}.inputSchemaHash`);
            if (
              tool.tokens !== undefined &&
              (typeof tool.tokens !== "number" || !Number.isSafeInteger(tool.tokens) || tool.tokens < 0)
            ) {
              invalid(`${toolField}.tokens`, "must be a nonnegative integer when present");
            }
          }
        }
        break;
    }
    const { sourcePath: _sourcePath, pin: _pin, ...metadata } = entry;
    return [
      id,
      {
        ...metadata,
        ...(entry.type !== "mcp" ? { installedPath: entry[pathKey] } : {}),
        source,
      } as LockEntry,
    ] as const;
  });
  return {
    version: lock.version,
    catalog,
    ...(lock.providers !== undefined
      ? { providers: lock.providers as Lockfile["providers"] }
      : {}),
    entries: Object.fromEntries(entries),
  };
};

export const lockfilePath = (targetRoot: string): string =>
  resolve(targetRoot, LOCKFILE_NAME);

export const lockfileExists = (targetRoot: string): boolean =>
  existsSync(lockfilePath(targetRoot));

export const readLockfile = (targetRoot: string): Lockfile | null => {
  const path = lockfilePath(targetRoot);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}. Fix the JSON syntax or restore the lockfile from version control: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseLockfile(parsed);
};

export const requireV2Lockfile = (lock: Lockfile): void => {
  if (lock.version !== LOCKFILE_VERSION) {
    throw new Error(
      `${LOCKFILE_NAME} version ${lock.version} cannot be modified. Run \`quiver-cli migrate\` first (preview with \`quiver-cli migrate --dry-run\`).`,
    );
  }
};

export const writeLockfile = (targetRoot: string, lock: Lockfile): void => {
  requireV2Lockfile(lock);
  const validated = parseLockfile(lock);
  // Sort every object, including snapshots and provenance, without reordering arrays.
  const content = JSON.stringify(
    validated,
    (_key, value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    },
    2,
  ) + "\n";
  const path = lockfilePath(targetRoot);
  assertSafeMutationPath(targetRoot, path, "Lockfile output");
  const mode = lstatSync(path, { throwIfNoEntry: false })?.mode;
  const temp = `${path}.tmp-${randomUUID()}`;
  assertSafeMutationPath(targetRoot, temp, "Lockfile temporary output");
  const fd = openSync(temp, "wx", mode ?? 0o666);
  let closed = false;
  try {
    writeFileSync(fd, content);
    closeSync(fd);
    closed = true;
    assertSafeMutationPath(targetRoot, path, "Lockfile output");
    renameSync(temp, path);
  } finally {
    try {
      if (!closed) closeSync(fd);
    } finally {
      try {
        unlinkSync(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
};

export const emptyLockfile = (
  catalogSource: string,
  remote: { ref?: string | null; resolved?: string | null } = {},
): Lockfile => ({
  version: LOCKFILE_VERSION,
  catalog: {
    source: catalogSource,
    ref: remote.ref ?? null,
    resolved: remote.resolved ?? null,
    fetchedAt: new Date().toISOString(),
  },
  entries: {},
});
