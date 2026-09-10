import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Copy a selected tree, resolving only relative links within its repository. */
export const materializeTree = (repository: string, source: string, destination: string): void => {
  const inside = (path: string): void => {
    const rel = relative(repository, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Unsafe tree entry: link escapes repository: ${path}`);
    }
  };
  const canonical = (path: string, links = new Set<string>()): string => {
    inside(path);
    if (path === repository) return path;
    const parent = canonical(dirname(path), links);
    const full = resolve(parent, relative(dirname(path), path));
    const stat = lstatSync(full);
    if (!stat.isSymbolicLink()) return full;
    if (links.has(full)) throw new Error(`Unsafe tree entry: symlink cycle: ${full}`);
    const target = readlinkSync(full);
    if (isAbsolute(target)) throw new Error(`Unsafe tree entry: absolute symlink: ${full}`);
    return canonical(resolve(parent, target), new Set([...links, full]));
  };
  const copy = (from: string, to: string, ancestors: Set<string>): void => {
    const full = canonical(from);
    if (ancestors.has(full)) throw new Error(`Unsafe tree entry: directory cycle: ${from}`);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      mkdirSync(to);
      const next = new Set([...ancestors, full]);
      for (const name of readdirSync(full).sort()) copy(resolve(full, name), resolve(to, name), next);
    } else if (stat.isFile() && stat.nlink === 1) {
      copyFileSync(full, to);
    } else {
      throw new Error(`Unsafe tree entry: special or hard-linked file: ${full}`);
    }
  };
  copy(source, destination, new Set());
};
