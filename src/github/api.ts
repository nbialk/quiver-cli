import { mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as tar from "tar";

import { resolveGithubToken } from "./auth.js";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const headers = (): Record<string, string> => {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "quiver-cli",
  };
  const token = resolveGithubToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
};

// Map common GitHub API failures to actionable messages.
const failureReason = (status: number): string => {
  if (status === 401)
    return "authentication failed - set GITHUB_TOKEN or log in with the gh CLI";
  if (status === 403 || status === 429)
    return "rate-limited or access denied (set GITHUB_TOKEN or log in with the gh CLI)";
  if (status === 404)
    return "repo or ref not found (private repo? set GITHUB_TOKEN or log in with the gh CLI)";
  return `HTTP ${status}`;
};

const apiFetch = async (url: string): Promise<ApiResult<Response>> => {
  let res: Response;
  try {
    res = await fetch(url, { headers: headers() });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "fetch failed",
    };
  }
  if (!res.ok) return { ok: false, reason: failureReason(res.status) };
  return { ok: true, value: res };
};

// Default branch of a repo ("owner/repo").
export const fetchDefaultBranch = async (
  repo: string,
): Promise<ApiResult<string>> => {
  const res = await apiFetch(`https://api.github.com/repos/${repo}`);
  if (!res.ok) return res;
  const body = (await res.value.json()) as { default_branch?: string };
  if (!body.default_branch) return { ok: false, reason: "no default branch" };
  return { ok: true, value: body.default_branch };
};

// Resolve a branch/tag/sha to a full commit SHA.
export const resolveCommitSha = async (
  repo: string,
  ref: string,
): Promise<ApiResult<string>> => {
  const res = await apiFetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
  );
  if (!res.ok) return res;
  const body = (await res.value.json()) as { sha?: string };
  if (!body.sha) return { ok: false, reason: "no commit sha in response" };
  return { ok: true, value: body.sha };
};

// Download the repo tarball at a commit SHA and extract it into destDir,
// stripping the top-level "<owner>-<repo>-<sha>/" folder. Works for private
// repos when a token is available.
export const downloadTarball = async (
  repo: string,
  sha: string,
  destDir: string,
): Promise<ApiResult<null>> => {
  const res = await apiFetch(
    `https://api.github.com/repos/${repo}/tarball/${sha}`,
  );
  if (!res.ok) return res;
  if (!res.value.body) return { ok: false, reason: "empty tarball response" };

  mkdirSync(destDir, { recursive: true });
  try {
    await pipeline(
      Readable.fromWeb(res.value.body),
      tar.x({ cwd: destDir, strip: 1 }),
    );
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "tarball extraction failed",
    };
  }
  return { ok: true, value: null };
};
