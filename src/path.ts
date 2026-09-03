import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

const isOutside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

export const resolveContainedPath = (
  root: string,
  path: string,
  label: string,
): string => {
  if (
    !path ||
    path === "." ||
    isAbsolute(path) ||
    win32.isAbsolute(path)
  ) {
    throw new Error(
      `${label} must be a relative path beneath ${root}: "${path}".`,
    );
  }
  const resolved = resolve(root, path.replaceAll("\\", "/"));
  if (isOutside(root, resolved)) {
    throw new Error(`${label} escapes ${root}: "${path}".`);
  }
  return resolved;
};

export const assertSafeMutationPath = (
  root: string,
  path: string,
  label: string,
  allowLeafSymlink = false,
): void => {
  const absRoot = resolve(root);
  const absPath = resolve(path);
  if (isOutside(absRoot, absPath)) {
    throw new Error(`${label} is outside target root ${absRoot}: ${absPath}.`);
  }

  const parts = relative(absRoot, absPath).split(/[\\/]/).filter(Boolean);
  if (allowLeafSymlink) parts.pop();
  let current = absRoot;
  for (const part of ["", ...parts]) {
    if (part) current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} has a symlinked parent: ${current}.`);
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        break;
      }
      throw error;
    }
  }
};
