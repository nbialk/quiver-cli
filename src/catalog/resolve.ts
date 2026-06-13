import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dist/cli.js -> package root is one level up from dist/.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ResolvedCatalog {
  /** The lockfile catalog.source string, e.g. "local:template/.agents". */
  source: string;
  /** Absolute path to the catalog's .agents directory. */
  root: string;
  /** Branch/tag for remote catalogs; absent/null for local. */
  ref?: string | null;
  /** Resolved commit SHA for remote catalogs; absent/null for local. */
  resolved?: string | null;
  /** ISO timestamp of the remote fetch; absent for local. */
  fetchedAt?: string;
}

export const DEFAULT_CATALOG_SOURCE = "local:template/.agents";

export interface ResolveCatalogOptions {
  /** Commit SHA pinned in the lockfile (github: sources only). */
  pinnedSha?: string | null;
}

// Resolve a catalog source string to an absolute .agents directory.
// local: points into the npm package; github: is fetched into the user cache
// (content-addressed by commit SHA) and resolved to a local path.
export const resolveCatalog = async (
  source: string = DEFAULT_CATALOG_SOURCE,
  options: ResolveCatalogOptions = {},
): Promise<ResolvedCatalog> => {
  const [scheme, ...rest] = source.split(":");
  const spec = rest.join(":");

  if (scheme === "local") {
    const root = resolve(packageRoot, spec);
    if (!existsSync(root)) {
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
