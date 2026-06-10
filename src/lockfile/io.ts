import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  type Lockfile,
} from "./schema.js";

export const lockfilePath = (targetRoot: string): string =>
  resolve(targetRoot, LOCKFILE_NAME);

export const lockfileExists = (targetRoot: string): boolean =>
  existsSync(lockfilePath(targetRoot));

export const readLockfile = (targetRoot: string): Lockfile | null => {
  const path = lockfilePath(targetRoot);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Lockfile;
  if (parsed.version !== LOCKFILE_VERSION) {
    throw new Error(
      `Unsupported ${LOCKFILE_NAME} version ${parsed.version}; expected ${LOCKFILE_VERSION}.`,
    );
  }
  return parsed;
};

// Deterministic serialisation: sorted entry keys so diffs stay minimal.
export const writeLockfile = (targetRoot: string, lock: Lockfile): void => {
  const sortedEntries: Lockfile["entries"] = {};
  for (const key of Object.keys(lock.entries).sort()) {
    sortedEntries[key] = lock.entries[key]!;
  }
  const ordered: Lockfile = {
    version: lock.version,
    catalog: lock.catalog,
    entries: sortedEntries,
  };
  writeFileSync(lockfilePath(targetRoot), JSON.stringify(ordered, null, 2) + "\n");
};

export const emptyLockfile = (catalogSource: string): Lockfile => ({
  version: LOCKFILE_VERSION,
  catalog: {
    source: catalogSource,
    ref: null,
    resolved: null,
    fetchedAt: new Date().toISOString(),
  },
  entries: {},
});
