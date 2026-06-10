import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadCatalog, type Catalog } from "./discover.js";
import type { ResolvedCatalog } from "./resolve.js";

// The materialized, repo-local catalog (.agents/). This is the source of truth
// for sync/status once `init` has run; it is committed to the repo.
export const repoCatalogRoot = (targetRoot: string): string =>
  resolve(targetRoot, ".agents");

export const repoCatalogExists = (targetRoot: string): boolean =>
  existsSync(repoCatalogRoot(targetRoot));

export const loadRepoCatalog = (
  targetRoot: string,
  source: string,
): { resolved: ResolvedCatalog; catalog: Catalog } => {
  const resolved: ResolvedCatalog = {
    source,
    root: repoCatalogRoot(targetRoot),
  };
  return { resolved, catalog: loadCatalog(resolved) };
};
