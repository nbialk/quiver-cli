import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTokenCache, resolveGithubToken } from "../src/github/auth.js";

// gh CLI is invoked via execFileSync; mock it so tests never shell out.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

import { execFileSync } from "node:child_process";

const mockedExecFileSync = vi.mocked(execFileSync);

describe("resolveGithubToken", () => {
  const originalGithub = process.env["GITHUB_TOKEN"];
  const originalGh = process.env["GH_TOKEN"];

  beforeEach(() => {
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
    mockedExecFileSync.mockReset();
    mockedExecFileSync.mockReturnValue("");
    resetTokenCache();
  });

  afterEach(() => {
    if (originalGithub === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = originalGithub;
    if (originalGh === undefined) delete process.env["GH_TOKEN"];
    else process.env["GH_TOKEN"] = originalGh;
    resetTokenCache();
  });

  it("prefers GITHUB_TOKEN over GH_TOKEN and the gh CLI", () => {
    process.env["GITHUB_TOKEN"] = "primary";
    process.env["GH_TOKEN"] = "secondary";
    mockedExecFileSync.mockReturnValue("from-gh");
    expect(resolveGithubToken()).toBe("primary");
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("falls back to GH_TOKEN when GITHUB_TOKEN is unset", () => {
    process.env["GH_TOKEN"] = "secondary";
    mockedExecFileSync.mockReturnValue("from-gh");
    expect(resolveGithubToken()).toBe("secondary");
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("falls back to the gh CLI when no env tokens are set", () => {
    mockedExecFileSync.mockReturnValue("from-gh\n");
    expect(resolveGithubToken()).toBe("from-gh");
  });

  it("returns null when nothing provides a token", () => {
    mockedExecFileSync.mockReturnValue("");
    expect(resolveGithubToken()).toBeNull();
  });

  it("returns null when the gh CLI is missing or errors", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("gh not found");
    });
    expect(resolveGithubToken()).toBeNull();
  });

  it("caches the resolved token for the process", () => {
    process.env["GITHUB_TOKEN"] = "first";
    expect(resolveGithubToken()).toBe("first");
    process.env["GITHUB_TOKEN"] = "second";
    expect(resolveGithubToken()).toBe("first");
  });
});
