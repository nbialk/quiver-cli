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
}

export const DEFAULT_CATALOG_SOURCE = "local:template/.agents";

// Resolve a catalog source string to an absolute .agents directory.
// Only the bundled local catalog is supported in v1; remote (github:) sources
// are reserved for a later phase but the scheme is already parsed here.
export const resolveCatalog = (
  source: string = DEFAULT_CATALOG_SOURCE,
): ResolvedCatalog => {
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
    throw new Error(
      "Remote (github:) catalogs are not supported yet. Use the bundled catalog.",
    );
  }

  throw new Error(`Unknown catalog source scheme: ${source}`);
};

export { packageRoot };
