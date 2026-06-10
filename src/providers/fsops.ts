import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

export interface FileOutput {
  path: string;
  content: string;
}

export interface SymlinkOutput {
  path: string;
  target: string;
}

export interface ManagedDir {
  path: string;
  expected: Set<string>;
}

const isENOENT = (e: unknown): boolean =>
  !!e && typeof e === "object" && "code" in e && (e as { code: string }).code === "ENOENT";

const isMatchingSymlink = (path: string, target: string): boolean => {
  const stats = lstatSync(path);
  if (!stats.isSymbolicLink()) return false;
  return resolve(dirname(path), readlinkSync(path)) === target;
};

// Remove a path whether it's a real file/dir or a (possibly broken) symlink.
export const removePath = (path: string): void => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (e) {
    if (isENOENT(e)) return;
    throw e;
  }
  if (stats.isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { force: true, recursive: true });
};

export interface ApplyResult {
  generated: string[];
  linked: string[];
  removed: string[];
}

// Apply file outputs, symlinks, removals and stale cleanup. Returns what changed.
export const applyOutputs = ({
  files,
  symlinks,
  removeFiles,
  removeDirs = [],
  managedDirs,
}: {
  files: FileOutput[];
  symlinks: SymlinkOutput[];
  removeFiles: string[];
  /** Directories (e.g. deselected provider shim dirs) to remove recursively. */
  removeDirs?: string[];
  managedDirs: ManagedDir[];
}): ApplyResult => {
  const result: ApplyResult = { generated: [], linked: [], removed: [] };

  for (const out of files) {
    let current: string | null = null;
    try {
      current = readFileSync(out.path, "utf8");
    } catch (e) {
      if (!isENOENT(e)) throw e;
    }
    if (current === out.content) continue;
    mkdirSync(dirname(out.path), { recursive: true });
    writeFileSync(out.path, out.content);
    result.generated.push(out.path);
  }

  for (const path of removeFiles) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    result.removed.push(path);
  }

  for (const path of removeDirs) {
    if (!existsSync(path)) continue;
    removePath(path);
    result.removed.push(path);
  }
  // Prune now-empty parents (e.g. .claude/ after its shim dirs are removed).
  for (const path of removeDirs) {
    try {
      rmdirSync(dirname(path));
    } catch {
      // not empty or already gone - keep user content untouched
    }
  }

  for (const link of symlinks) {
    mkdirSync(dirname(link.path), { recursive: true });
    try {
      if (isMatchingSymlink(link.path, link.target)) continue;
    } catch (e) {
      if (!isENOENT(e)) throw e;
    }
    removePath(link.path);
    symlinkSync(
      relative(dirname(link.path), link.target),
      link.path,
      lstatSync(link.target).isDirectory() ? "dir" : "file",
    );
    result.linked.push(link.path);
  }

  for (const dir of managedDirs) {
    if (!existsSync(dir.path)) continue;
    for (const child of readdirSync(dir.path)) {
      if (dir.expected.has(child)) continue;
      const childPath = resolve(dir.path, child);
      removePath(childPath);
      result.removed.push(childPath);
    }
  }

  return result;
};

// Check-mode counterpart: report mismatches without writing.
export const checkOutputs = ({
  files,
  symlinks,
  removeFiles,
  removeDirs = [],
  managedDirs,
}: {
  files: FileOutput[];
  symlinks: SymlinkOutput[];
  removeFiles: string[];
  removeDirs?: string[];
  managedDirs: ManagedDir[];
}): string[] => {
  const problems: string[] = [];

  for (const out of files) {
    try {
      if (readFileSync(out.path, "utf8") !== out.content) {
        problems.push(`out of sync: ${out.path}`);
      }
    } catch (e) {
      if (isENOENT(e)) problems.push(`missing: ${out.path}`);
      else throw e;
    }
  }

  for (const path of removeFiles) {
    if (existsSync(path)) problems.push(`stale (should be removed): ${path}`);
  }

  for (const path of removeDirs) {
    if (existsSync(path)) problems.push(`stale (should be removed): ${path}`);
  }

  for (const link of symlinks) {
    try {
      if (!isMatchingSymlink(link.path, link.target)) {
        problems.push(`out of sync symlink: ${link.path}`);
      }
    } catch (e) {
      if (isENOENT(e)) problems.push(`missing symlink: ${link.path}`);
      else throw e;
    }
  }

  for (const dir of managedDirs) {
    if (!existsSync(dir.path)) continue;
    for (const child of readdirSync(dir.path)) {
      if (!dir.expected.has(child)) {
        problems.push(`unexpected shim: ${resolve(dir.path, child)}`);
      }
    }
  }

  return problems;
};
