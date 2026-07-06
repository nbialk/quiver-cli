import { execFileSync } from "node:child_process";

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
    process.env["GITHUB_TOKEN"] ??
    process.env["GH_TOKEN"] ??
    ghToken();
  return cachedToken;
};

// Test hook: reset the cached token between cases.
export const resetTokenCache = (): void => {
  cachedToken = undefined;
};
