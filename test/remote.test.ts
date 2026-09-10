import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogCacheDir, catalogCacheRoot, fetchRemoteCatalog, parseGithubSource } from "../src/catalog/remote.js";
import { downloadTarball, fetchDefaultBranch, resolveCommitSha } from "../src/github/api.js";
import { resolveGithubDirectory } from "../src/sources/github.js";

vi.mock("../src/github/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/github/api.js")>(),
  downloadTarball: vi.fn(), fetchDefaultBranch: vi.fn(), resolveCommitSha: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

const SHA = "a".repeat(40);
let cache: string;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "quiver-remote-"));
  vi.stubEnv("XDG_CACHE_HOME", cache);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
  vi.mocked(fetchDefaultBranch).mockResolvedValue({ ok: true, value: "main" });
  vi.mocked(resolveCommitSha).mockResolvedValue({ ok: true, value: SHA });
  vi.mocked(downloadTarball).mockImplementation(async (_repo, _sha, dest) => {
    mkdirSync(join(dest, "skills/one"), { recursive: true });
    mkdirSync(join(dest, "skills/two"), { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "# Repository skill\n");
    writeFileSync(join(dest, "skills/one/SKILL.md"), "# One\n");
    writeFileSync(join(dest, "skills/two/SKILL.md"), "# Two\n");
    return { ok: true, value: null };
  });
});

afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("parseGithubSource", () => {
  it.each([
    ["github:acme/skills", "", null],
    ["github:acme/skills/catalogs/.agents", "catalogs/.agents", null],
    ["github:acme/skills#v2", "", "v2"],
    ["github:acme/skills/.agents#release/1.x", ".agents", "release/1.x"],
    [`github:acme/skills#${SHA}`, "", SHA],
  ])("parses %s", (source, path, ref) => {
    expect(parseGithubSource(source!)).toEqual({ repo: "acme/skills", path, ref });
  });

  it("normalizes only repository identity, not paths or requested refs", () => {
    expect(parseGithubSource("github:Acme/Skills/MySkill#Release/Next")).toEqual({
      repo: "acme/skills", path: "MySkill", ref: "Release/Next",
    });
  });

  it.each([
    "acme/skills", "https://github.com/acme/skills", "gitlab:acme/skills", "local:skills",
    "github:acme", "github:/acme/skills", "github:acme//skills", "github:../skills", "github:acme/..",
    "github:acme/skills/", "github:acme/skills/.", "github:acme/skills/a/../b",
    "github:acme/skills/../../outside", "github:acme/skills/C:\\outside", "github:acme/skills/a\\b",
    "github:acme/skills/a//b", "github:acme/skills/%2e%2e/x", "github:acme/skills/a?b",
    "github:acme/skills/a\0b", "github:acme/skills#", "github:acme/skills#main#extra",
    "github:acme/skills#../main", "github:acme/skills#refs//main", "github:acme/skills#branch name",
    "github:acme/skills#branch.lock", "github:acme/skills#branch@{1}",
    "github:acme/skills\n",
  ])("rejects noncanonical or unsupported source %s", (source) => {
    expect(() => parseGithubSource(source)).toThrow(/Invalid GitHub source/);
  });
});

describe("catalog cache identity", () => {
  it("respects XDG_CACHE_HOME and keys by normalized repo and full SHA", () => {
    expect(catalogCacheRoot()).toBe(resolve(cache, "quiver/catalogs"));
    expect(catalogCacheDir("Acme/Skills", SHA.toUpperCase())).toBe(
      resolve(cache, "quiver/catalogs", createHash("sha256").update("acme/skills").digest("hex"), SHA),
    );
  });

  it("does not collide for hyphenated repos or common SHA prefixes", () => {
    expect(catalogCacheDir("a-b/c", SHA)).not.toBe(catalogCacheDir("a/b-c", SHA));
    expect(catalogCacheDir("acme/skills", SHA)).not.toBe(catalogCacheDir("acme/skills", "a".repeat(39) + "b"));
  });

  it.each(["main", "abcdef", "a".repeat(39), "g".repeat(40), "../outside", "", `${SHA}\n`])(
    "rejects invalid SHA %s before building a cache path", (sha) => {
      expect(() => catalogCacheDir("acme/skills", sha)).toThrow(/cache identity/);
    },
  );
});

describe("resolveGithubDirectory", () => {
  it("resolves the default branch once and downloads that exact SHA, retaining null ref", async () => {
    const result = await resolveGithubDirectory("github:Acme/Skills");
    expect(fetchDefaultBranch).toHaveBeenCalledExactlyOnceWith("acme/skills");
    expect(resolveCommitSha).toHaveBeenCalledExactlyOnceWith("acme/skills", "main");
    expect(downloadTarball).toHaveBeenCalledExactlyOnceWith("acme/skills", SHA, expect.any(String));
    expect(result).toEqual({
      source: "github:Acme/Skills", repo: "acme/skills", path: "", ref: null,
      resolved: SHA, root: join(catalogCacheDir("acme/skills", SHA), "tree"),
      fetchedAt: expect.any(String),
    });
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
  });

  it("resolves a slash ref, not a path's latest commit", async () => {
    const result = await resolveGithubDirectory("github:acme/skills/skills/one#release/1.x");
    expect(fetchDefaultBranch).not.toHaveBeenCalled();
    expect(resolveCommitSha).toHaveBeenCalledExactlyOnceWith("acme/skills", "release/1.x");
    expect(downloadTarball).toHaveBeenCalledWith("acme/skills", SHA, expect.any(String));
    expect(result.ref).toBe("release/1.x");
    expect(result.path).toBe("skills/one");
  });

  it.each([null, "main", "release/1.x"])("pins %s without any live ref resolution", async (ref) => {
    const source = `github:acme/skills${ref === null ? "" : `#${ref}`}`;
    const result = await resolveGithubDirectory(source, { pinnedSha: SHA.toUpperCase() });
    expect(result.ref).toBe(ref);
    expect(result.resolved).toBe(SHA);
    expect(fetchDefaultBranch).not.toHaveBeenCalled();
    expect(resolveCommitSha).not.toHaveBeenCalled();
    expect(downloadTarball).toHaveBeenCalledWith("acme/skills", SHA, expect.any(String));
  });

  it("treats a full explicit SHA as fixed, even without a lockfile pin", async () => {
    const source = `github:acme/skills#${SHA.toUpperCase()}`;
    const result = await resolveGithubDirectory(source);
    expect(result.ref).toBe(SHA.toUpperCase());
    expect(result.resolved).toBe(SHA);
    expect(fetchDefaultBranch).not.toHaveBeenCalled();
    expect(resolveCommitSha).not.toHaveBeenCalled();
    expect(downloadTarball).toHaveBeenCalledWith("acme/skills", SHA, expect.any(String));
  });

  it("uses a valid pinned cache with zero network and shares it across subpaths", async () => {
    const first = await resolveGithubDirectory("github:acme/skills/skills/one", { pinnedSha: SHA });
    vi.mocked(downloadTarball).mockClear().mockRejectedValue(new Error("Network disabled"));
    const second = await resolveGithubDirectory("github:ACME/Skills/skills/two", { pinnedSha: SHA });
    expect(second.root).toBe(join(dirname(first.root), "two"));
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(downloadTarball).not.toHaveBeenCalled();
    expect(resolveCommitSha).not.toHaveBeenCalled();
    expect(fetchDefaultBranch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps unpinned sources moving even when an older cache exists", async () => {
    await resolveGithubDirectory("github:acme/skills");
    const next = "a".repeat(39) + "b";
    vi.mocked(resolveCommitSha).mockResolvedValue({ ok: true, value: next });
    const result = await resolveGithubDirectory("github:acme/skills");
    expect(result.resolved).toBe(next);
    expect(downloadTarball).toHaveBeenLastCalledWith("acme/skills", next, expect.any(String));
    expect(existsSync(catalogCacheDir("acme/skills", SHA))).toBe(true);
  });

  it.each(["", "main", "a".repeat(39), "g".repeat(40), "../outside", `${SHA}\n`])(
    "rejects unvalidated pins %s with no network", async (pinnedSha) => {
      await expect(resolveGithubDirectory("github:acme/skills", { pinnedSha })).rejects.toThrow(/Invalid pinned/);
      expect(downloadTarball).not.toHaveBeenCalled();
      expect(fetchDefaultBranch).not.toHaveBeenCalled();
      expect(resolveCommitSha).not.toHaveBeenCalled();
    },
  );

  it("rejects a pin that disagrees with a fixed source", async () => {
    await expect(resolveGithubDirectory(`github:acme/skills#${SHA}`, { pinnedSha: "b".repeat(40) }))
      .rejects.toThrow(/does not match/);
    expect(downloadTarball).not.toHaveBeenCalled();
  });

  it("defensively rejects an invalid resolved SHA", async () => {
    vi.mocked(resolveCommitSha).mockResolvedValue({ ok: true, value: "../outside" });
    await expect(resolveGithubDirectory("github:acme/skills#main")).rejects.toThrow(/Invalid resolved/);
    expect(downloadTarball).not.toHaveBeenCalled();
  });

  it.each(["default branch", "commit"])("propagates sanitized %s API failures without downloading", async (kind) => {
    if (kind === "default branch") vi.mocked(fetchDefaultBranch).mockResolvedValue({ ok: false, reason: "HTTP 500" });
    else vi.mocked(resolveCommitSha).mockResolvedValue({ ok: false, reason: "HTTP 500" });
    await expect(resolveGithubDirectory("github:acme/skills")).rejects.toThrow(/Cannot resolve acme\/skills: HTTP 500/);
    expect(downloadTarball).not.toHaveBeenCalled();
  });

  it.each(["missing marker", "bad JSON", "wrong repo", "wrong SHA", "bad date", "wrong digest", "changed file", "missing file", "extra file", "linked tree", "linked marker"])(
    "rebuilds an invalid cache: %s", async (damage) => {
      await resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA });
      const dir = catalogCacheDir("acme/skills", SHA);
      const marker = join(dir, "manifest.json");
      const manifest = JSON.parse(readFileSync(marker, "utf8"));
      if (damage === "missing marker") rmSync(marker);
      if (damage === "bad JSON") writeFileSync(marker, "{");
      if (damage === "wrong repo") writeFileSync(marker, JSON.stringify({ ...manifest, repo: "other/repo" }));
      if (damage === "wrong SHA") writeFileSync(marker, JSON.stringify({ ...manifest, resolved: "b".repeat(40) }));
      if (damage === "bad date") writeFileSync(marker, JSON.stringify({ ...manifest, fetchedAt: "invalid" }));
      if (damage === "wrong digest") writeFileSync(marker, JSON.stringify({ ...manifest, digest: "sha256:bad" }));
      if (damage === "changed file") writeFileSync(join(dir, "tree/SKILL.md"), "Changed");
      if (damage === "missing file") rmSync(join(dir, "tree/SKILL.md"));
      if (damage === "extra file") writeFileSync(join(dir, "tree/extra"), "Extra");
      if (damage === "linked tree") {
        const outside = join(cache, "outside");
        cpSync(join(dir, "tree"), outside, { recursive: true });
        rmSync(join(dir, "tree"), { recursive: true });
        symlinkSync(outside, join(dir, "tree"));
      }
      if (damage === "linked marker") {
        writeFileSync(join(cache, "marker"), JSON.stringify(manifest));
        rmSync(marker);
        symlinkSync(join(cache, "marker"), marker);
      }
      await resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA });
      expect(downloadTarball).toHaveBeenCalledTimes(2);
      expect(readdirSync(dirname(dir))).toEqual([SHA]);
    },
  );

  it("rejects a symlinked cache parent without touching its target", async () => {
    const outside = join(cache, "outside");
    mkdirSync(outside);
    mkdirSync(catalogCacheRoot(), { recursive: true });
    symlinkSync(outside, dirname(catalogCacheDir("acme/skills", SHA)));
    await expect(resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA })).rejects.toThrow(/symlinked parent/);
    expect(readdirSync(outside)).toEqual([]);
    expect(downloadTarball).not.toHaveBeenCalled();
  });

  it.each(["file", "symlink"])("replaces invalid cache %s entries without trusting or following them", async (kind) => {
    const dir = catalogCacheDir("acme/skills", SHA);
    mkdirSync(dirname(dir), { recursive: true });
    const outside = join(cache, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "Keep\n");
    if (kind === "file") writeFileSync(dir, "Not a directory");
    else symlinkSync(outside, dir);
    await resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA });
    expect(downloadTarball).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("Keep\n");
  });

  it.each(["result", "exception"])("cleans staging after download %s failure", async (kind) => {
    vi.mocked(downloadTarball).mockImplementation(async (_repo, _sha, dest) => {
      writeFileSync(join(dest, "partial"), "Partial");
      if (kind === "exception") throw new Error("Download interrupted");
      return { ok: false, reason: "Download interrupted" };
    });
    await expect(resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA })).rejects.toThrow(/Download interrupted/);
    expect(readdirSync(dirname(catalogCacheDir("acme/skills", SHA)))).toEqual([]);
  });

  it("does not swallow an unrelated rename failure", async () => {
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("Permission denied"); });
    await expect(resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA })).rejects.toThrow(/Cannot publish/);
    expect(readdirSync(dirname(catalogCacheDir("acme/skills", SHA)))).toEqual([]);
  });

  it("accepts only a fully validated concurrent winner", async () => {
    const [first, second] = await Promise.all([
      resolveGithubDirectory("github:acme/skills/skills/one", { pinnedSha: SHA }),
      resolveGithubDirectory("github:acme/skills/skills/one", { pinnedSha: SHA }),
    ]);
    expect(first).toEqual(second);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(readdirSync(dirname(catalogCacheDir("acme/skills", SHA)))).toEqual([SHA]);
  });

  it("waits for another publisher's lock and never removes its winner", async () => {
    const first = await resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA });
    const dir = catalogCacheDir("acme/skills", SHA);
    const winner = join(cache, "winner");
    cpSync(dir, winner, { recursive: true });
    rmSync(dir, { recursive: true });
    mkdirSync(`${dir}.lock`);
    vi.mocked(renameSync).mockClear();
    const pending = resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA });
    await new Promise<void>((resolve) => setImmediate(resolve));
    cpSync(winner, dir, { recursive: true });
    rmSync(`${dir}.lock`, { recursive: true });
    expect(await pending).toEqual(first);
    expect(renameSync).not.toHaveBeenCalled();
    expect(readdirSync(dirname(dir))).toEqual([SHA]);
  });

  it("bounds publication lock waits and cleans only its own staging", async () => {
    const dir = catalogCacheDir("acme/skills", SHA);
    mkdirSync(`${dir}.lock`, { recursive: true });
    vi.mocked(delay).mockResolvedValue(undefined);
    await expect(resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA }))
      .rejects.toThrow(/publication lock/);
    expect(delay).toHaveBeenCalledTimes(600);
    expect(readdirSync(dirname(dir))).toEqual([`${SHA}.lock`]);
  });

  it("rejects an invalid concurrent destination and cleans its own staging", async () => {
    vi.mocked(renameSync).mockImplementationOnce((_from, to) => {
      mkdirSync(to);
      writeFileSync(join(String(to), "manifest.json"), "{}");
      throw new Error("Destination exists");
    });
    await expect(resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA })).rejects.toThrow(/Cannot publish/);
    expect(readdirSync(dirname(catalogCacheDir("acme/skills", SHA)))).toEqual([SHA]);
  });

  it.each(["missing", "SKILL.md"])("requires a selected directory, not %s", async (path) => {
    await expect(resolveGithubDirectory(`github:acme/skills/${path}`, { pinnedSha: SHA }))
      .rejects.toThrow(/directory not found/);
  });

  it("materializes internal links but rejects a symlink as the selected root", async () => {
    vi.mocked(downloadTarball).mockImplementationOnce(async (_repo, _sha, dest) => {
      mkdirSync(join(dest, "safe"));
      writeFileSync(join(dest, "safe/SKILL.md"), "# Safe\n");
      symlinkSync("safe", join(dest, "alias"));
      return { ok: true, value: null };
    });
    await resolveGithubDirectory("github:acme/skills/safe", { pinnedSha: SHA });
    await expect(resolveGithubDirectory("github:acme/skills/alias", { pinnedSha: SHA })).rejects.toThrow(/symlinked parent/);
    const result = await resolveGithubDirectory("github:acme/skills", { pinnedSha: SHA });
    expect(readFileSync(join(result.root, "alias/SKILL.md"), "utf8")).toBe("# Safe\n");
    expect(downloadTarball).toHaveBeenCalledTimes(1);
  });

  it("keeps the catalog wrapper compatible", async () => {
    const result = await fetchRemoteCatalog("github:acme/skills/skills/one", { pinnedSha: SHA });
    expect(result.source).toBe("github:acme/skills/skills/one");
    expect(result.ref).toBeNull();
    expect(result.resolved).toBe(SHA);
    expect(readFileSync(join(result.root, "SKILL.md"), "utf8")).toBe("# One\n");
  });
});
