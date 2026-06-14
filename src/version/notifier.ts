import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { packageRoot } from "../catalog/resolve.js";

const REGISTRY_URL = "https://registry.npmjs.org/quiver-cli/latest";
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 2000;
const INSTALL_HINT = "pnpm add -g quiver-cli";

// Cache root: $XDG_CACHE_HOME/quiver, falling back to ~/.cache/quiver. Holds
// update-check.json (last registry lookup, to honor the TTL across runs).
const cacheFilePath = (): string => {
  const base = process.env["XDG_CACHE_HOME"] || resolve(homedir(), ".cache");
  return resolve(base, "quiver", "update-check.json");
};

interface UpdateCache {
  checkedAt: string;
  latest: string | null;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export const installHint = (): string => INSTALL_HINT;

// Installed quiver-cli version, read from the package.json next to the build.
export const getCurrentVersion = (): string => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
};

// Compare two dotted version strings. Returns 1 if a > b, -1 if a < b, 0 if
// equal. Prerelease suffixes (e.g. 1.2.0-rc.1) sort below their release.
export const compareSemver = (a: string, b: string): number => {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core = "", ...preParts] = v.replace(/^v/, "").split("-");
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: preParts.length > 0 };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const da = pa.nums[i] ?? 0;
    const db = pb.nums[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  if (pa.pre !== pb.pre) return pa.pre ? -1 : 1;
  return 0;
};

const readCache = (): UpdateCache | null => {
  const path = cacheFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UpdateCache;
  } catch {
    return null;
  }
};

const writeCache = (cache: UpdateCache): void => {
  try {
    const path = cacheFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // A non-writable cache must never break the CLI.
  }
};

// Fetch the latest published version from the npm registry. Any failure
// (offline, timeout, non-2xx, malformed) resolves to null - never throws.
const fetchLatestVersion = async (): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export interface CheckOptions {
  /** Ignore the TTL and always hit the registry (used by `version`). */
  force?: boolean;
}

// Resolve the latest version, using the cached lookup when it is still fresh.
// All I/O is best-effort; on any failure `latest` is null.
export const checkForUpdate = async (
  options: CheckOptions = {},
): Promise<UpdateInfo> => {
  const current = getCurrentVersion();
  const cache = readCache();

  let latest = cache?.latest ?? null;
  const fresh =
    cache && Date.now() - new Date(cache.checkedAt).getTime() < CHECK_TTL_MS;

  if (options.force || !fresh) {
    const fetched = await fetchLatestVersion();
    if (fetched) {
      latest = fetched;
      writeCache({ checkedAt: new Date().toISOString(), latest: fetched });
    } else if (!cache) {
      // Record the attempt so a flaky network doesn't hammer the registry.
      writeCache({ checkedAt: new Date().toISOString(), latest: null });
    }
  }

  const updateAvailable =
    latest !== null && compareSemver(latest, current) > 0;
  return { current, latest, updateAvailable };
};

// Whether to suppress the passive (post-command) notice: opt-out env, CI,
// non-interactive stdout, or machine-readable output.
export const notifierSuppressed = (json: boolean): boolean =>
  Boolean(process.env["QUIVER_NO_UPDATE_NOTIFIER"]) ||
  Boolean(process.env["CI"]) ||
  !process.stdout.isTTY ||
  json;
