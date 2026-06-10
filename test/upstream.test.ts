import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateOrigin,
  resetTokenCache,
  resolveGithubToken,
  type CommitResult,
  type UpstreamOrigin,
} from "../src/catalog/upstreams.js";

const origin = (over: Partial<UpstreamOrigin> = {}): UpstreamOrigin => ({
  repo: "owner/repo",
  path: "skills/x",
  ref: "main",
  commit: null,
  fetchedAt: null,
  ...over,
});

const commit = (sha: string): CommitResult => ({
  ok: true,
  sha,
  date: "2026-01-01T00:00:00Z",
});

describe("evaluateOrigin", () => {
  it("records a baseline on first check and mutates the origin", () => {
    const o = origin();
    const { report, changed } = evaluateOrigin("x", o, commit("a".repeat(40)));
    expect(report.status).toBe("baseline");
    expect(changed).toBe(true);
    expect(o.commit).toBe("a".repeat(40));
    expect(o.fetchedAt).not.toBeNull();
  });

  it("reports ok when the recorded commit matches upstream", () => {
    const o = origin({ commit: "b".repeat(40), fetchedAt: "t" });
    const { report, changed } = evaluateOrigin("x", o, commit("b".repeat(40)));
    expect(report.status).toBe("ok");
    expect(changed).toBe(false);
  });

  it("reports drift when upstream commit differs", () => {
    const o = origin({ commit: "b".repeat(40), fetchedAt: "t" });
    const { report } = evaluateOrigin("x", o, commit("c".repeat(40)));
    expect(report.status).toBe("drift");
    expect(report.from).toBe("bbbbbbbbbb");
    expect(report.to).toBe("cccccccccc");
  });

  it("flags curated skills separately on drift", () => {
    const o = origin({ commit: "b".repeat(40), fetchedAt: "t", curated: true });
    const { report } = evaluateOrigin("x", o, commit("c".repeat(40)));
    expect(report.status).toBe("drift-curated");
  });

  it("does not overwrite the baseline when curated drift is detected", () => {
    const o = origin({ commit: "b".repeat(40), fetchedAt: "t", curated: true });
    evaluateOrigin("x", o, commit("c".repeat(40)));
    expect(o.commit).toBe("b".repeat(40));
  });

  it("skips on fetch error without changing the origin", () => {
    const o = origin({ commit: "b".repeat(40) });
    const { report, changed } = evaluateOrigin("x", o, {
      ok: false,
      reason: "rate-limited",
    });
    expect(report.status).toBe("skipped");
    expect(report.reason).toBe("rate-limited");
    expect(changed).toBe(false);
    expect(o.commit).toBe("b".repeat(40));
  });
});

describe("resolveGithubToken", () => {
  const originalGithub = process.env["GITHUB_TOKEN"];
  const originalGh = process.env["GH_TOKEN"];

  afterEach(() => {
    if (originalGithub === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = originalGithub;
    if (originalGh === undefined) delete process.env["GH_TOKEN"];
    else process.env["GH_TOKEN"] = originalGh;
    resetTokenCache();
  });

  it("prefers GITHUB_TOKEN over GH_TOKEN", () => {
    process.env["GITHUB_TOKEN"] = "primary";
    process.env["GH_TOKEN"] = "secondary";
    resetTokenCache();
    expect(resolveGithubToken()).toBe("primary");
  });

  it("falls back to GH_TOKEN when GITHUB_TOKEN is unset", () => {
    delete process.env["GITHUB_TOKEN"];
    process.env["GH_TOKEN"] = "secondary";
    resetTokenCache();
    expect(resolveGithubToken()).toBe("secondary");
  });

  it("caches the resolved token until reset", () => {
    process.env["GITHUB_TOKEN"] = "first";
    resetTokenCache();
    expect(resolveGithubToken()).toBe("first");
    process.env["GITHUB_TOKEN"] = "second";
    expect(resolveGithubToken()).toBe("first");
    resetTokenCache();
    expect(resolveGithubToken()).toBe("second");
  });
});
