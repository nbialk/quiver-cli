import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authFilePath,
  deleteStoredToken,
  readStoredLogin,
  readStoredToken,
  resetTokenCache,
  resolveGithubToken,
  writeStoredToken,
} from "../src/github/auth.js";

describe("stored token (auth.json)", () => {
  let tmp: string;
  const originalXdg = process.env["XDG_CONFIG_HOME"];
  const originalGithub = process.env["GITHUB_TOKEN"];
  const originalGh = process.env["GH_TOKEN"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "quiver-auth-"));
    process.env["XDG_CONFIG_HOME"] = tmp;
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
    resetTokenCache();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalXdg;
    if (originalGithub === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = originalGithub;
    if (originalGh === undefined) delete process.env["GH_TOKEN"];
    else process.env["GH_TOKEN"] = originalGh;
    resetTokenCache();
  });

  it("writes, reads and deletes the token", () => {
    expect(readStoredToken()).toBeNull();
    writeStoredToken("ghp_secret", "octocat");
    expect(readStoredToken()).toBe("ghp_secret");
    expect(readStoredLogin()).toBe("octocat");
    expect(deleteStoredToken()).toBe(true);
    expect(readStoredToken()).toBeNull();
    expect(deleteStoredToken()).toBe(false);
  });

  it("creates auth.json with mode 0600", () => {
    writeStoredToken("ghp_secret", "octocat");
    const mode = statSync(authFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes valid JSON with a createdAt timestamp", () => {
    writeStoredToken("ghp_secret", "octocat");
    const parsed = JSON.parse(readFileSync(authFilePath(), "utf8")) as {
      github: { token: string; login: string; createdAt: string };
    };
    expect(parsed.github.token).toBe("ghp_secret");
    expect(parsed.github.createdAt).toMatch(/^\d{4}-/);
  });

  it("env tokens take precedence over the stored token", () => {
    writeStoredToken("ghp_stored", "octocat");
    process.env["GITHUB_TOKEN"] = "ghp_env";
    resetTokenCache();
    expect(resolveGithubToken()).toBe("ghp_env");
  });

  it("falls back to the stored token when env is unset", () => {
    writeStoredToken("ghp_stored", "octocat");
    resetTokenCache();
    expect(resolveGithubToken()).toBe("ghp_stored");
  });
});
