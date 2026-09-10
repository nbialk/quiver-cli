import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

import { fileDigest, jsonDigest, treeDigest } from "../catalog/digest.js";
import {
  downloadTarball,
  fetchDefaultBranch,
  isCommitSha,
  isGithubRef,
  isGithubRepo,
  resolveCommitSha,
} from "../github/api.js";
import { assertSafeMutationPath } from "../path.js";
import { materializeTree } from "./materialize.js";

export interface GithubSpec {
  repo: string;
  path: string;
  /** Requested branch/tag/SHA; null tracks the repository's default branch. */
  ref: string | null;
}

export const parseGithubSource = (source: string): GithubSpec => {
  const match = /^github:([^#]+)(?:#([^#]*))?$/.exec(source);
  const [owner, repo, ...parts] = (match?.[1] ?? "").split("/");
  if (!match || !owner || !repo || !isGithubRepo(`${owner}/${repo}`)) {
    throw new Error(
      "Invalid GitHub source. Expected github:owner/repo[/path][#ref].",
    );
  }
  const ref = match[2] ?? null;
  if (ref !== null && !isGithubRef(ref)) {
    throw new Error("Invalid GitHub source: invalid or empty #ref.");
  }
  if (parts.some((part) =>
    !part || part === "." || part === ".." ||
    /[\\\s\x00-\x1f\x7f%<>:"|?*\uD800-\uDFFF]/u.test(part),
  )) {
    throw new Error(
      "Invalid GitHub source: subpath must be a canonical relative path.",
    );
  }
  return { repo: `${owner}/${repo}`.toLowerCase(), path: parts.join("/"), ref };
};

export const catalogCacheRoot = (): string =>
  resolve(
    process.env["XDG_CACHE_HOME"] || resolve(homedir(), ".cache"),
    "quiver", "catalogs",
  );

export const catalogCacheDir = (repo: string, sha: string): string => {
  if (!isGithubRepo(repo) || !isCommitSha(sha)) {
    throw new Error("Invalid GitHub cache identity");
  }
  const identity = createHash("sha256").update(repo.toLowerCase()).digest("hex");
  return resolve(catalogCacheRoot(), identity, sha.toLowerCase());
};

export interface GithubDirectoryOptions {
  pinnedSha?: string | null;
}

export interface ResolvedGithubDirectory extends GithubSpec {
  source: string;
  root: string;
  resolved: string;
  fetchedAt: string;
}

interface CacheManifest {
  version: 1;
  repo: string;
  resolved: string;
  fetchedAt: string;
  digest: string;
}

// Unlike a selected skill, the rest of a repository can contain links. Record
// their targets without following them, and include empty directories as well.
const cacheDigest = (root: string): string => {
  if (!lstatSync(root).isDirectory()) throw new Error("Unsafe GitHub cache root");
  const entries: unknown[] = [];
  const walk = (path: string): void => {
    const full = resolve(root, path);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      entries.push([path, "directory"]);
      for (const name of readdirSync(full).sort()) {
        walk(path ? `${path}/${name}` : name);
      }
    } else if (stat.isFile()) {
      entries.push([path, "file", stat.nlink, fileDigest(full)]);
    } else if (stat.isSymbolicLink()) {
      entries.push([path, "link", readlinkSync(full)]);
    } else {
      throw new Error("Unsafe GitHub cache entry");
    }
  };
  walk("");
  return jsonDigest(entries);
};

const readCache = (
  dir: string,
  repo: string,
  sha: string,
): CacheManifest | null => {
  try {
    const manifestPath = resolve(dir, "manifest.json");
    const tree = resolve(dir, "tree");
    const stat = lstatSync(manifestPath);
    if (
      !lstatSync(dir).isDirectory() || !lstatSync(tree).isDirectory() ||
      !stat.isFile() || stat.nlink !== 1 || stat.size > 4096
    ) return null;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return null;
    }
    const value = manifest as Record<string, unknown>;
    if (
      value["version"] !== 1 || value["repo"] !== repo || value["resolved"] !== sha ||
      typeof value["fetchedAt"] !== "string" ||
      new Date(value["fetchedAt"]).toISOString() !== value["fetchedAt"] ||
      typeof value["digest"] !== "string" || value["digest"] !== cacheDigest(tree)
    ) return null;
    return {
      version: 1, repo, resolved: sha,
      fetchedAt: value["fetchedAt"], digest: value["digest"],
    };
  } catch {
    return null;
  }
};

export const resolveGithubDirectory = async (
  source: string,
  options: GithubDirectoryOptions = {},
): Promise<ResolvedGithubDirectory> => {
  const spec = parseGithubSource(source);
  if (options.pinnedSha != null && !isCommitSha(options.pinnedSha)) {
    throw new Error(
      "Invalid pinned GitHub commit SHA: expected 40 hexadecimal characters.",
    );
  }
  const fixed = isCommitSha(spec.ref) ? spec.ref.toLowerCase() : null;
  let sha = options.pinnedSha?.toLowerCase() ?? fixed;
  if (fixed && sha !== fixed) {
    throw new Error("Pinned GitHub commit does not match the source SHA.");
  }
  if (!sha) {
    let ref = spec.ref;
    if (ref === null) {
      const branch = await fetchDefaultBranch(spec.repo);
      if (!branch.ok) throw new Error(`Cannot resolve ${spec.repo}: ${branch.reason}`);
      ref = branch.value;
    }
    const commit = await resolveCommitSha(spec.repo, ref);
    if (!commit.ok) throw new Error(`Cannot resolve ${spec.repo}: ${commit.reason}`);
    if (!isCommitSha(commit.value)) throw new Error("Invalid resolved GitHub commit SHA");
    sha = commit.value.toLowerCase();
  }

  const cacheDir = catalogCacheDir(spec.repo, sha);
  assertSafeMutationPath(catalogCacheRoot(), dirname(cacheDir), "GitHub cache");
  let manifest = readCache(cacheDir, spec.repo, sha);
  if (!manifest) {
    mkdirSync(dirname(cacheDir), { recursive: true });
    const tmp = mkdtempSync(`${cacheDir}.tmp-`);
    try {
      const tree = resolve(tmp, "tree");
      mkdirSync(tree);
      const result = await downloadTarball(spec.repo, sha, tree);
      if (!result.ok) {
        throw new Error(`Cannot download ${spec.repo}@${sha}: ${result.reason}`);
      }
      manifest = {
        version: 1, repo: spec.repo, resolved: sha,
        fetchedAt: new Date().toISOString(), digest: cacheDigest(tree),
      };
      writeFileSync(resolve(tmp, "manifest.json"), JSON.stringify(manifest), {
        flag: "wx",
      });

      // Serialize repair/publication across processes, not downloads. Recheck
      // under the lock so an earlier cache miss cannot delete a new winner.
      const lock = `${cacheDir}.lock`;
      for (let attempt = 0; ; attempt += 1) {
        try {
          mkdirSync(lock);
          break;
        } catch (error) {
          if (
            !error || typeof error !== "object" || !("code" in error) ||
            error.code !== "EEXIST" || attempt >= 600
          ) {
            throw new Error("Cannot acquire GitHub cache publication lock");
          }
          await setTimeout(100);
        }
      }
      try {
        const winner = readCache(cacheDir, spec.repo, sha);
        if (winner) {
          manifest = winner;
        } else {
          rmSync(cacheDir, { recursive: true, force: true });
          try {
            renameSync(tmp, cacheDir);
          } catch {
            manifest = readCache(cacheDir, spec.repo, sha);
            if (!manifest) throw new Error("Cannot publish GitHub cache entry");
          }
        }
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const tree = resolve(cacheDir, "tree");
  let root = resolve(tree, spec.path);
  assertSafeMutationPath(tree, root, "GitHub source directory");
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `GitHub source directory not found in ${spec.repo}@${sha}: ${spec.path || "."}`,
    );
  }
  try {
    treeDigest(root);
  } catch {
    // Keep the authenticated raw cache intact. Publish a separate, link-free
    // projection keyed by its content, so downstream digests/copies stay strict.
    const staging = mkdtempSync(resolve(cacheDir, "materialized.tmp-"));
    try {
      const selected = resolve(staging, "tree");
      materializeTree(tree, root, selected);
      const digest = treeDigest(selected);
      const projected = resolve(cacheDir, `materialized-${digest.replace(":", "-")}`);
      assertSafeMutationPath(cacheDir, projected, "Materialized GitHub source");
      if (lstatSync(projected, { throwIfNoEntry: false })) {
        if (treeDigest(projected) !== digest) throw new Error("Corrupt materialized GitHub source");
      } else {
        try {
          renameSync(selected, projected);
        } catch (error) {
          if (treeDigest(projected) !== digest) throw error;
        }
      }
      root = projected;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { source, root, ...spec, resolved: sha, fetchedAt: manifest.fetchedAt };
};
