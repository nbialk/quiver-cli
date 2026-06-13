import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCatalogWritable,
  packageRoot,
  type ResolvedCatalog,
} from "../src/catalog/resolve.js";
import { upstream } from "../src/commands/upstream.js";
import {
  evaluateOrigin,
  resetTokenCache,
  resolveGithubToken,
  type CommitResult,
  type UpstreamOrigin,
} from "../src/catalog/upstreams.js";

const cliOptions = (over: Record<string, unknown> = {}) => ({
  targetRoot: process.cwd(),
  force: false,
  all: false,
  json: false,
  introspectStdio: false,
  providers: null,
  catalog: null,
  positionals: [],
  ...over,
});

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

describe("isCatalogWritable", () => {
  const local = (root: string): ResolvedCatalog => ({
    source: `local:${root}`,
    root,
  });

  it("treats remote (github:) catalogs as read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "quiver-cat-"));
    try {
      const remote: ResolvedCatalog = { source: "github:owner/repo", root: dir };
      expect(isCatalogWritable(remote)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows the bundled catalog from a source checkout (not node_modules)", () => {
    // The test run resolves packageRoot to the repo's src/, which is not under
    // node_modules, so the bundled catalog is writable.
    expect(packageRoot.split(sep).includes("node_modules")).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "quiver-cat-"));
    try {
      expect(isCatalogWritable(local(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for a non-existent catalog path", () => {
    const dir = join(tmpdir(), "quiver-cat-missing-xyz");
    expect(isCatalogWritable(local(dir))).toBe(false);
  });
});

describe("upstream guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("aborts without fetching when the catalog is not writable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dir = mkdtempSync(join(tmpdir(), "quiver-ro-"));
    chmodSync(dir, 0o500); // read + execute, no write

    try {
      await upstream(cliOptions({ catalog: `local:${dir}` }) as never);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
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
