import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ResolvedCatalog } from "./resolve.js";

export interface UpstreamOrigin {
  /** GitHub "owner/repo". */
  repo: string;
  /** Path of the skill directory within the repo. */
  path: string;
  /** Branch/tag to track. */
  ref: string;
  /** Recorded baseline commit SHA; null until first check records it. */
  commit: string | null;
  /** ISO timestamp of the last recorded baseline; null until then. */
  fetchedAt: string | null;
  /** Locally modified after import — drift is expected, flag for manual review. */
  curated?: boolean;
}

export type UpstreamMap = Record<string, UpstreamOrigin>;

export const UPSTREAMS_FILE = "upstreams.json";

const upstreamsPath = (catalog: ResolvedCatalog): string =>
  resolve(catalog.root, UPSTREAMS_FILE);

export const loadUpstreams = (catalog: ResolvedCatalog): UpstreamMap => {
  const path = upstreamsPath(catalog);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as UpstreamMap;
};

export const writeUpstreams = (
  catalog: ResolvedCatalog,
  map: UpstreamMap,
): void => {
  writeFileSync(upstreamsPath(catalog), JSON.stringify(map, null, 2) + "\n");
};

export interface LatestCommit {
  ok: true;
  sha: string;
  date: string;
}

export interface CommitError {
  ok: false;
  reason: string;
}

export type CommitResult = LatestCommit | CommitError;

let cachedToken: string | null | undefined;

// Try the gh CLI's stored token. Returns null if gh is missing or not logged in.
const ghToken = (): string | null => {
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
};

// Resolve a GitHub token from (in order): GITHUB_TOKEN, GH_TOKEN, the gh CLI.
// Cached for the process. Returns null to fall back to anonymous requests.
export const resolveGithubToken = (): string | null => {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken =
    process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? ghToken();
  return cachedToken;
};

// Test hook: reset the cached token between cases.
export const resetTokenCache = (): void => {
  cachedToken = undefined;
};

// Fetch the most recent commit SHA that touched a path on a given ref. Uses the
// GitHub Commits API (no clone/download). GITHUB_TOKEN lifts the 60 req/h
// anonymous rate limit when present.
export const fetchLatestCommit = async (
  origin: Pick<UpstreamOrigin, "repo" | "path" | "ref">,
): Promise<CommitResult> => {
  const url =
    `https://api.github.com/repos/${origin.repo}/commits` +
    `?path=${encodeURIComponent(origin.path)}` +
    `&sha=${encodeURIComponent(origin.ref)}&per_page=1`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "quiver-cli",
  };
  const token = resolveGithubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "fetch failed" };
  }

  if (res.status === 403 || res.status === 429) {
    return {
      ok: false,
      reason: "rate-limited (set GITHUB_TOKEN or log in with the gh CLI)",
    };
  }
  if (res.status === 404) {
    return { ok: false, reason: "repo or path not found" };
  }
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  const body = (await res.json()) as Array<{
    sha?: string;
    commit?: { committer?: { date?: string } };
  }>;
  const head = Array.isArray(body) ? body[0] : undefined;
  if (!head?.sha) return { ok: false, reason: "no commits for path" };

  return {
    ok: true,
    sha: head.sha,
    date: head.commit?.committer?.date ?? "",
  };
};

export type UpstreamStatus =
  | "baseline"
  | "ok"
  | "drift"
  | "drift-curated"
  | "skipped";

export interface UpstreamReport {
  name: string;
  status: UpstreamStatus;
  repo: string;
  path: string;
  /** Recorded baseline commit (short), when present. */
  from?: string;
  /** Latest upstream commit (short) and its date, when fetched. */
  to?: string;
  date?: string;
  reason?: string;
}

const short = (sha: string): string => sha.slice(0, 10);

// Compare one origin against upstream. Mutates `origin.commit`/`fetchedAt` when
// recording a baseline; returns a report and whether the map changed.
export const evaluateOrigin = (
  name: string,
  origin: UpstreamOrigin,
  result: CommitResult,
): { report: UpstreamReport; changed: boolean } => {
  const base = { name, repo: origin.repo, path: origin.path };

  if (!result.ok) {
    return {
      report: { ...base, status: "skipped", reason: result.reason },
      changed: false,
    };
  }

  if (!origin.commit) {
    origin.commit = result.sha;
    origin.fetchedAt = new Date().toISOString();
    return {
      report: { ...base, status: "baseline", to: short(result.sha), date: result.date },
      changed: true,
    };
  }

  if (origin.commit === result.sha) {
    return {
      report: { ...base, status: "ok", from: short(origin.commit) },
      changed: false,
    };
  }

  return {
    report: {
      ...base,
      status: origin.curated ? "drift-curated" : "drift",
      from: short(origin.commit),
      to: short(result.sha),
      date: result.date,
    },
    changed: false,
  };
};
