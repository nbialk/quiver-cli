import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import * as tar from "tar";

import { resolveGithubToken } from "./auth.js";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export const isGithubRepo = (value: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/i.test(value) &&
  !/\s/.test(value) &&
  ![".", ".."].includes(value.split("/")[1]!);

export const isCommitSha = (value: unknown): value is string =>
  typeof value === "string" && value.length === 40 && /^[a-f0-9]{40}$/i.test(value);

export const isGithubRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  value !== "@" && !/[\s\x00-\x1f\x7f~^:?*\[\\#\uD800-\uDFFF]/u.test(value) &&
  !value.includes("..") && !value.includes("@{") && !value.endsWith(".") &&
  value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));

const headers = (): Record<string, string> => {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "quiver-cli",
  };
  const token = resolveGithubToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
};

const failureReason = (status: number): string => {
  if (status === 401)
    return "authentication failed - set GITHUB_TOKEN or log in with the gh CLI";
  if (status === 403 || status === 429)
    return "rate-limited or access denied (set GITHUB_TOKEN or log in with the gh CLI)";
  if (status === 404)
    return "repo or ref not found (private repo? set GITHUB_TOKEN or log in with the gh CLI)";
  return `HTTP ${status}`;
};

// The deadline covers response bodies too. Never surface fetch errors, response
// payloads or redirect URLs: they may contain credentials or signed URLs.
const apiRequest = async <T>(
  path: string,
  consume: (response: Response, signal: AbortSignal) => Promise<ApiResult<T>>,
): Promise<ApiResult<T>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  let response: Response | undefined;
  try {
    response = await fetch(`https://api.github.com/repos/${path}`, {
      headers: headers(),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: failureReason(response.status) };
    return await consume(response, controller.signal);
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? "GitHub request timed out" : "GitHub request failed",
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) {
      await response.body.cancel().catch(() => {});
    }
  }
};

const readBounded = async (
  stream: Readable,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  await pipeline(stream, new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) return callback(new Error("Response exceeds size limit"));
      chunks.push(chunk);
      callback();
    },
  }), { signal });
  return Buffer.concat(chunks, size);
};

const apiString = (
  path: string,
  field: string,
  valid: (value: unknown) => value is string,
): Promise<ApiResult<string>> => apiRequest(path, async (response, signal) => {
  try {
    if (!response.body) throw new Error("Missing body");
    const bytes = await readBounded(Readable.fromWeb(response.body), 1024 * 1024, signal);
    const body: unknown = JSON.parse(bytes.toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const value = (body as Record<string, unknown>)[field];
      if (valid(value)) return { ok: true, value };
    }
  } catch {
    signal.throwIfAborted();
  }
  return { ok: false, reason: "invalid GitHub API response" };
});

export const fetchDefaultBranch = async (repo: string): Promise<ApiResult<string>> => {
  if (!isGithubRepo(repo)) return { ok: false, reason: "invalid GitHub repository" };
  return apiString(repo, "default_branch", isGithubRef);
};

export const resolveCommitSha = async (
  repo: string,
  ref: string,
): Promise<ApiResult<string>> => {
  if (!isGithubRepo(repo) || !isGithubRef(ref)) {
    return { ok: false, reason: "invalid GitHub repository or ref" };
  }
  const result = await apiString(`${repo}/commits/${encodeURIComponent(ref)}`, "sha", isCommitSha);
  return result.ok ? { ok: true, value: result.value.toLowerCase() } : result;
};

// Extract only into an empty staging directory. tar's default containment checks
// stay enabled; strict mode makes skipped unsafe entries a failure, not success.
export const downloadTarball = async (
  repo: string,
  sha: string,
  destDir: string,
): Promise<ApiResult<null>> => {
  if (!isGithubRepo(repo) || !isCommitSha(sha)) {
    return { ok: false, reason: "invalid GitHub repository or commit SHA" };
  }
  return apiRequest(`${repo}/tarball/${sha.toLowerCase()}`, async (response, signal) => {
    if (!response.body) return { ok: false, reason: "empty tarball response" };
    try {
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_DOWNLOAD_BYTES) throw new Error("Oversized archive");
      let bytes = await readBounded(Readable.fromWeb(response.body), MAX_DOWNLOAD_BYTES, signal);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        bytes = await readBounded(
          Readable.from([bytes]).pipe(createGunzip()), MAX_ARCHIVE_BYTES, signal,
        );
      }
      // Do not let tar auto-decompress a second, unbounded compression layer.
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error("Nested compression");

      mkdirSync(destDir, { recursive: true });
      if (!lstatSync(destDir).isDirectory() || readdirSync(destDir).length) {
        throw new Error("Extraction directory must be empty and not a link");
      }
      let prefix: string | undefined;
      let entries = 0;
      let complete = false;
      const seen = new Set<string>();
      const paths = new Map<string, string>();
      const pathParts = (path: string): string[] => {
        const parts = path.replace(/\/$/, "").split("/");
        if (
          path.length > 4096 || parts.length > 65 ||
          /[\\\x00-\x1f\x7f<>:"|?*]/.test(path) || win32.isAbsolute(path) ||
          parts.some((part) =>
            !part || part === "." || part === ".." || /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
          )
        ) throw new Error("Unsafe archive path");
        return parts;
      };
      const unpack = tar.x({
        cwd: destDir, strip: 1, sync: true, strict: true,
        preserveOwner: false, maxDepth: 64, brotli: false, zstd: false,
        filter(path, entry) {
          if (!(entry instanceof tar.ReadEntry)) throw new Error("Invalid archive entry");
          const parts = pathParts(path);
          prefix ??= parts[0];
          const key = parts.join("/").normalize("NFC").toLowerCase();
          entries += 1;
          if (
            entries > 50_000 || parts[0] !== prefix || seen.has(key) ||
            !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_DOWNLOAD_BYTES ||
            !["File", "OldFile", "ContiguousFile", "Directory", "GNUDumpDir", "Link", "SymbolicLink"].includes(entry.type) ||
            (parts.length === 1 && entry.type !== "Directory")
          ) throw new Error("Invalid or oversized archive entry");
          seen.add(key);
          let current = "";
          for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const normalized = current.normalize("NFC").toLowerCase();
            const previous = paths.get(normalized);
            if (previous && previous !== current) throw new Error("Aliased archive path");
            paths.set(normalized, current);
            if (paths.size > 50_000) throw new Error("Too many archive paths");
          }
          if (entry.mode !== undefined) entry.mode &= 0o777;
          if (entry.type === "Link") {
            const target = pathParts(entry.linkpath ?? "");
            if (target.length < 2 || target[0] !== prefix) throw new Error("Unsafe archive link");
          } else if (entry.type === "SymbolicLink") {
            const target = entry.linkpath ?? "";
            const resolved = posix.normalize(posix.join(posix.dirname(parts.slice(1).join("/")), target));
            if (
              !target || /[\\\x00-\x1f\x7f:]/.test(target) || win32.isAbsolute(target) ||
              resolved === ".." || resolved.startsWith("../")
            ) throw new Error("Unsafe archive link");
          }
          return true;
        },
      });
      unpack.on("ignoredEntry", () => { throw new Error("Unsupported archive entry"); });
      unpack.on("eof", () => { complete = true; });
      // Synchronous extraction leaves no pending writes when staging is cleaned up.
      unpack.end(bytes);
      if (!complete || !entries) throw new Error("Incomplete archive");
      return { ok: true, value: null };
    } catch {
      signal.throwIfAborted();
      return { ok: false, reason: "invalid, unsafe or oversized GitHub tarball, or extraction failed" };
    }
  });
};
