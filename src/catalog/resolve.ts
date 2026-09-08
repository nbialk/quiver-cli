import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dist/cli.js -> package root is one level up from dist/.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ResolvedCatalog {
  /** Discovery source, e.g. "github:nbialk/quiver-catalog". */
  source: string;
  /** Absolute path to the catalog directory. */
  root: string;
  /** Requested branch/tag/SHA; null tracks the default branch. Absent for local. */
  ref?: string | null;
  /** Resolved commit SHA for remote catalogs; absent/null for local. */
  resolved?: string | null;
  /** ISO timestamp of the remote fetch; absent for local. */
  fetchedAt?: string;
}

export const DEFAULT_CATALOG_SOURCE = "github:nbialk/quiver-catalog";

export interface ResolveCatalogOptions {
  /** Commit SHA pinned in the lockfile (github: sources only). */
  pinnedSha?: string | null;
}

// Local catalogs require explicit absolute paths. Legacy package-relative
// locators are provenance only and must never be reinterpreted here.
export const resolveCatalog = async (
  source: string = DEFAULT_CATALOG_SOURCE,
  options: ResolveCatalogOptions = {},
): Promise<ResolvedCatalog> => {
  const [scheme, ...rest] = source.split(":");
  const spec = rest.join(":");

  if (scheme === "local") {
    if (!isAbsolute(spec) || /[\x00-\x1f\x7f]/.test(spec)) {
      throw new Error(
        "Local catalog sources require an explicit absolute path: local:/absolute/path. Legacy package-relative sources are provenance only.",
      );
    }
    const root = resolve(spec);
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Catalog not found at ${root} (source: ${source}).`);
    }
    return { source, root };
  }

  if (scheme === "github") {
    const { fetchRemoteCatalog } = await import("./remote.js");
    return fetchRemoteCatalog(source, options);
  }

  throw new Error(`Unknown catalog source scheme: ${source}`);
};

export { packageRoot };
