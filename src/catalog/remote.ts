import { existsSync, mkdtempSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  downloadTarball,
  fetchDefaultBranch,
  resolveCommitSha,
} from "../github/api.js";
import type { ResolvedCatalog } from "./resolve.js";

// A parsed "github:owner/repo[/path][#ref]" catalog source.
export interface GithubSpec {
  /** "owner/repo". */
  repo: string;
  /** Path of the catalog dir within the repo; "" = repo root. */
  path: string;
  /** Branch/tag/sha from "#ref"; null = default branch. */
  ref: string | null;
}

// Parse "github:owner/repo[/path][#ref]". Throws on malformed specs.
export const parseGithubSource = (source: string): GithubSpec => {
  const spec = source.startsWith("github:") ? source.slice("github:".length) : source;
  const [location = "", ...refParts] = spec.split("#");
  const ref = refParts.length ? refParts.join("#") : null;
  const segments = location.split("/").filter(Boolean);
  const [owner, repo, ...pathParts] = segments;
  if (!owner || !repo) {
    throw new Error(
      `Invalid catalog source "${source}". Expected github:owner/repo[/path][#ref].`,
    );
  }
  if (ref !== null && !ref) {
    throw new Error(`Invalid catalog source "${source}": empty #ref.`);
  }
  return { repo: `${owner}/${repo}`, path: pathParts.join("/"), ref };
};

// Cache root: $XDG_CACHE_HOME/quiver/catalogs, falling back to
// ~/.cache/quiver/catalogs. Entries are content-addressed by commit SHA and
// therefore immutable - a cache hit needs no network.
export const catalogCacheRoot = (): string => {
  const base = process.env["XDG_CACHE_HOME"] || resolve(homedir(), ".cache");
  return resolve(base, "quiver", "catalogs");
};

export const catalogCacheDir = (repo: string, sha: string): string =>
  resolve(catalogCacheRoot(), `${repo.replace("/", "-")}-${sha.slice(0, 12)}`);

export interface RemoteCatalogOptions {
  /** Commit SHA pinned in the lockfile; skips ref resolution when set. */
  pinnedSha?: string | null;
}

// Resolve a github: catalog source to a local directory: determine the commit
// SHA (pinned or live), download the repo tarball into the cache on a miss,
// and return the catalog root inside the cached checkout.
export const fetchRemoteCatalog = async (
  source: string,
  options: RemoteCatalogOptions = {},
): Promise<ResolvedCatalog> => {
  const spec = parseGithubSource(source);

  let ref = spec.ref;
  let sha = options.pinnedSha ?? null;

  if (!sha) {
    if (!ref) {
      const branch = await fetchDefaultBranch(spec.repo);
      if (!branch.ok) {
        throw new Error(`Cannot resolve ${spec.repo}: ${branch.reason}`);
      }
      ref = branch.value;
    }
    const commit = await resolveCommitSha(spec.repo, ref);
    if (!commit.ok) {
      throw new Error(`Cannot resolve ${spec.repo}@${ref}: ${commit.reason}`);
    }
    sha = commit.value;
  }

  const cacheDir = catalogCacheDir(spec.repo, sha);
  if (!existsSync(cacheDir)) {
    // Download into a temp sibling, then rename - never expose partial extracts.
    mkdirSync(dirname(cacheDir), { recursive: true });
    const tmp = mkdtempSync(`${cacheDir}.tmp-`);
    const result = await downloadTarball(spec.repo, sha, tmp);
    if (!result.ok) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`Cannot download ${spec.repo}@${sha.slice(0, 12)}: ${result.reason}`);
    }
    try {
      renameSync(tmp, cacheDir);
    } catch {
      // Lost the race against a concurrent fetch; the cache entry exists now.
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const root = spec.path ? resolve(cacheDir, spec.path) : cacheDir;
  if (!existsSync(root)) {
    throw new Error(
      `Catalog path "${spec.path}" not found in ${spec.repo}@${sha.slice(0, 12)}.`,
    );
  }

  return { source, root, ref, resolved: sha, fetchedAt: new Date().toISOString() };
};
