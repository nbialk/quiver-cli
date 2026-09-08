import { resolveGithubDirectory } from "../sources/github.js";
import type { GithubDirectoryOptions } from "../sources/github.js";
import type { ResolvedCatalog } from "./resolve.js";

export {
  catalogCacheDir,
  catalogCacheRoot,
  parseGithubSource,
} from "../sources/github.js";
export type { GithubSpec } from "../sources/github.js";

export type RemoteCatalogOptions = GithubDirectoryOptions;

export const fetchRemoteCatalog = (
  source: string,
  options: RemoteCatalogOptions = {},
): Promise<ResolvedCatalog> => resolveGithubDirectory(source, options);
