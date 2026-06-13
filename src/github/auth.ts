import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Global quiver config dir: $XDG_CONFIG_HOME/quiver, falling back to
// ~/.config/quiver. Holds auth.json (the stored GitHub token).
export const configDir = (): string => {
  const base = process.env["XDG_CONFIG_HOME"] || resolve(homedir(), ".config");
  return resolve(base, "quiver");
};

export const authFilePath = (): string => resolve(configDir(), "auth.json");

interface AuthFile {
  github?: {
    token: string;
    /** GitHub login the token was validated against. */
    login: string | null;
    createdAt: string;
  };
}

const readAuthFile = (): AuthFile | null => {
  const path = authFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AuthFile;
  } catch {
    return null;
  }
};

// Token stored by `quiver-cli login`; null when not logged in.
export const readStoredToken = (): string | null =>
  readAuthFile()?.github?.token ?? null;

export const readStoredLogin = (): string | null =>
  readAuthFile()?.github?.login ?? null;

// Store a validated token. The file is created with mode 0600 and re-chmodded
// on every write (writeFileSync's mode only applies on creation).
export const writeStoredToken = (token: string, login: string | null): void => {
  mkdirSync(configDir(), { recursive: true });
  const file: AuthFile = {
    github: { token, login, createdAt: new Date().toISOString() },
  };
  writeFileSync(authFilePath(), JSON.stringify(file, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(authFilePath(), 0o600);
  resetTokenCache();
};

// Remove the stored token. Returns false when there was none.
export const deleteStoredToken = (): boolean => {
  const path = authFilePath();
  if (!existsSync(path)) return false;
  rmSync(path);
  resetTokenCache();
  return true;
};

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

// Resolve a GitHub token from (in order): GITHUB_TOKEN, GH_TOKEN, the token
// stored by `quiver-cli login`, the gh CLI. Cached for the process. Returns
// null to fall back to anonymous requests.
export const resolveGithubToken = (): string | null => {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken =
    process.env["GITHUB_TOKEN"] ??
    process.env["GH_TOKEN"] ??
    readStoredToken() ??
    ghToken();
  return cachedToken;
};

// Test hook: reset the cached token between cases.
export const resetTokenCache = (): void => {
  cachedToken = undefined;
};

export type TokenValidation =
  | { ok: true; login: string }
  | { ok: false; reason: string };

// Validate a token against GET /user and return the authenticated login.
export const validateToken = async (
  token: string,
): Promise<TokenValidation> => {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "quiver-cli",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "fetch failed",
    };
  }
  if (res.status === 401) return { ok: false, reason: "token is invalid or expired" };
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const body = (await res.json()) as { login?: string };
  return { ok: true, login: body.login ?? "unknown" };
};
