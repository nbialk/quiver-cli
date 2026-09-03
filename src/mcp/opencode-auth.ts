import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// opencode stores MCP OAuth credentials per server in
// $XDG_DATA_HOME/opencode/mcp-auth.json (fallback ~/.local/share/opencode).
// Quiver reads them read-only to introspect OAuth-protected HTTP servers.
// It never refreshes or writes tokens: refresh-token rotation would
// invalidate opencode's own copy.

export type OpencodeTokenResult =
  | { status: "ok"; accessToken: string }
  | { status: "expired" }
  | { status: "none" };

const EXPIRY_SKEW_MS = 30_000;

const authFilePath = (): string => {
  const base =
    process.env["XDG_DATA_HOME"] || resolve(homedir(), ".local", "share");
  return resolve(base, "opencode", "mcp-auth.json");
};

interface OpencodeAuthEntry {
  serverUrl?: string;
  tokens?: { accessToken?: string; expiresAt?: number };
}

const normalizeUrl = (url: string): string =>
  url.trim().replace(/\/+$/, "").toLowerCase();

// Look up an access token for the given server, matching by URL first (the
// stable identifier) and falling back to the opencode server name only for
// legacy entries without a URL.
export const findOpencodeToken = (
  name: string,
  url: string,
): OpencodeTokenResult => {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(authFilePath(), "utf8"));
  } catch {
    return { status: "none" };
  }
  if (typeof data !== "object" || data === null) return { status: "none" };

  const entries = data as Record<string, OpencodeAuthEntry | undefined>;
  const target = normalizeUrl(url);
  const namedEntry = entries[name];
  const entry =
    Object.values(entries).find(
      (e) => e?.serverUrl && normalizeUrl(e.serverUrl) === target,
    ) ?? (namedEntry?.serverUrl === undefined ? namedEntry : undefined);

  const tokens = entry?.tokens;
  if (!tokens?.accessToken) return { status: "none" };

  if (typeof tokens.expiresAt === "number") {
    // opencode stores epoch seconds; be defensive about milliseconds.
    const expiresMs =
      tokens.expiresAt > 1e12 ? tokens.expiresAt : tokens.expiresAt * 1000;
    if (expiresMs - EXPIRY_SKEW_MS <= Date.now()) return { status: "expired" };
  }
  return { status: "ok", accessToken: tokens.accessToken };
};
