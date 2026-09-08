import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";

import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadTarball, fetchDefaultBranch, resolveCommitSha } from "../src/github/api.js";
import { resolveGithubToken } from "../src/github/auth.js";

vi.mock("../src/github/auth.js", () => ({ resolveGithubToken: vi.fn(() => "test-token-secret") }));
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, createGunzip: vi.fn(actual.createGunzip) };
});

const SHA = "a".repeat(40);
const fetchMock = vi.fn<typeof fetch>();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quiver-github-api-"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  vi.mocked(createGunzip).mockReset();
  vi.useRealTimers();
});

type ArchiveEntry = tar.HeaderData & { content?: string };
const archive = (entries: ArchiveEntry[], gzip = true): Buffer => {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const data = { mode: 0o644, type: "File" as const, size: content.length, ...entry };
    const header = new tar.Header({ ...data, type: entry.type === "Unsupported" ? "File" : data.type });
    if (header.encode()) chunks.push(new tar.Pax(data).encode());
    if (entry.type === "Unsupported") {
      header.block![156] = 0x5a;
      header.block!.fill(0x20, 148, 156);
      const checksum = header.block!.reduce((sum, byte) => sum + byte, 0);
      header.block!.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    }
    chunks.push(header.block!, content);
    if (content.length % 512) chunks.push(Buffer.alloc(512 - content.length % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const bytes = Buffer.concat(chunks);
  return gzip ? gzipSync(bytes) : bytes;
};

const archiveResponse = (entries: ArchiveEntry[], gzip = true): void => {
  fetchMock.mockResolvedValue(new Response(new Uint8Array(archive(entries, gzip))));
};

describe("GitHub API", () => {
  it("validates a default branch response and sets auth without exposing it", async () => {
    fetchMock.mockResolvedValue(Response.json({ default_branch: "release/main" }));
    expect(await fetchDefaultBranch("acme/skills")).toEqual({ ok: true, value: "release/main" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/acme/skills", {
      headers: {
        Accept: "application/vnd.github+json", "User-Agent": "quiver-cli", Authorization: "Bearer test-token-secret",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("encodes slash refs and validates full commit SHAs", async () => {
    fetchMock.mockResolvedValue(Response.json({ sha: SHA.toUpperCase() }));
    expect(await resolveCommitSha("acme/skills", "release/1.x")).toEqual({ ok: true, value: SHA });
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/acme/skills/commits/release%2F1.x", expect.any(Object));
  });

  it.each([
    [401, /authentication/], [403, /rate-limited/], [429, /rate-limited/], [404, /not found/], [500, /HTTP 500/],
  ])("sanitizes HTTP %s errors without reading raw payloads", async (status, reason) => {
    fetchMock.mockResolvedValue(new Response("token-secret signed-url?token=secret", { status }));
    const result = await fetchDefaultBranch("acme/skills");
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(reason) });
    expect(JSON.stringify(result)).not.toMatch(/token-secret|signed-url/);
  });

  it("sanitizes thrown network errors", async () => {
    fetchMock.mockRejectedValue(new Error("https://signed-url.example?token=test-token-secret"));
    expect(await fetchDefaultBranch("acme/skills")).toEqual({ ok: false, reason: "GitHub request failed" });
  });

  it.each([null, [], {}, { default_branch: 1 }, { default_branch: "" }, { default_branch: "main\nsecret" }, { default_branch: "../main" }])(
    "rejects malformed repository JSON %j", async (body) => {
      fetchMock.mockResolvedValue(Response.json(body));
      expect(await fetchDefaultBranch("acme/skills")).toEqual({ ok: false, reason: "invalid GitHub API response" });
    },
  );

  it.each([null, [], {}, { sha: 123 }, { sha: "abc123" }, { sha: "g".repeat(40) }, { sha: `${SHA}/../../outside` }, { sha: `${SHA}\n` }])(
    "rejects malformed commit JSON %j", async (body) => {
      fetchMock.mockResolvedValue(Response.json(body));
      expect(await resolveCommitSha("acme/skills", "main")).toEqual({ ok: false, reason: "invalid GitHub API response" });
    },
  );

  it.each(["not JSON: test-token-secret", " ".repeat(1024 * 1024 + 1)])("bounds and sanitizes invalid JSON", async (body) => {
    fetchMock.mockResolvedValue(new Response(body));
    expect(await fetchDefaultBranch("acme/skills")).toEqual({ ok: false, reason: "invalid GitHub API response" });
  });

  it("times out a request and aborts it", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("secret timeout URL")), { once: true });
    }));
    const result = fetchDefaultBranch("acme/skills");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toEqual({ ok: false, reason: "GitHub request timed out" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled response body as well as headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const result = fetchDefaultBranch("acme/skills");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toEqual({ ok: false, reason: "GitHub request timed out" });
    expect(cancel).toHaveBeenCalled();
  });

  it.each(["../repo", "owner/repo/extra", "https://github.com/owner/repo", "owner/repo?token=secret"])(
    "rejects unsafe repository input %s without network", async (repo) => {
      expect((await fetchDefaultBranch(repo)).ok).toBe(false);
      expect((await resolveCommitSha(repo, "main")).ok).toBe(false);
      expect((await downloadTarball(repo, SHA, dir)).ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid refs and download pins without network", async () => {
    expect((await resolveCommitSha("acme/skills", "../main")).ok).toBe(false);
    expect((await resolveCommitSha("acme/skills", "\ud800")).ok).toBe(false);
    expect((await downloadTarball("acme/skills", "main", dir)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("downloadTarball", () => {
  it.each([true, false])("downloads exact SHA and extracts a suitable archive (gzip=%s)", async (gzip) => {
    archiveResponse([
      { path: "acme-skills-abc/", type: "Directory" },
      { path: "acme-skills-abc/skills/cleanup/SKILL.md", content: "# Cleanup\n" },
      { path: "acme-skills-abc/skills/cleanup/scripts/run.sh", content: "exit 0\n", mode: 0o755 },
    ], gzip);
    expect(await downloadTarball("acme/skills", SHA, dir)).toEqual({ ok: true, value: null });
    expect(fetchMock).toHaveBeenCalledWith(`https://api.github.com/repos/acme/skills/tarball/${SHA}`, expect.any(Object));
    expect(readFileSync(join(dir, "skills/cleanup/SKILL.md"), "utf8")).toBe("# Cleanup\n");
    expect(readFileSync(join(dir, "skills/cleanup/scripts/run.sh"), "utf8")).toBe("exit 0\n");
    expect(lstatSync(join(dir, "skills/cleanup/scripts/run.sh")).mode & 0o111).toBe(0o111);
  });

  it("preserves safe links elsewhere in a repository for selected-tree validation", async () => {
    archiveResponse([
      { path: "repo/skills/cleanup/SKILL.md", content: "# Cleanup\n" },
      { path: "repo/docs/reference.md", content: "Reference\n" },
      { path: "repo/links/reference.md", type: "SymbolicLink", linkpath: "../docs/reference.md" },
    ]);
    expect(await downloadTarball("acme/skills", SHA, dir)).toEqual({ ok: true, value: null });
    expect(readlinkSync(join(dir, "links/reference.md"))).toBe("../docs/reference.md");
  });

  it("supports GitHub-style PAX long filenames", async () => {
    const source = join(dir, "input");
    const dest = join(dir, "output");
    mkdirSync(join(source, "repo"), { recursive: true });
    const filename = "resource-" + "a".repeat(120) + ".md";
    writeFileSync(join(source, "repo", filename), "Resource\n");
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ cwd: source, gzip: true }, ["repo"])) chunks.push(chunk);
    fetchMock.mockResolvedValue(new Response(new Uint8Array(Buffer.concat(chunks))));
    expect(await downloadTarball("acme/skills", SHA, dest)).toEqual({ ok: true, value: null });
    expect(readFileSync(join(dest, filename), "utf8")).toBe("Resource\n");
  });

  it.each([
    "../escape", "/repo/escape", "repo/../escape", "repo/a/../../escape", "repo/./alias", "repo//alias",
    "C:/repo/escape", "repo/a\\..\\escape", "repo/C:escape", "repo/" + "deep/".repeat(65) + "file",
    "repo/alias.", "repo/alias ", "repo/CON",
  ])("rejects unsafe archive path %s rather than skipping it", async (path) => {
    archiveResponse([{ path, content: "Unsafe\n" }]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
    expect(existsSync(join(dirname(dir), "escape"))).toBe(false);
  });

  it.each([
    { type: "SymbolicLink", linkpath: "../../escape" },
    { type: "SymbolicLink", linkpath: "/tmp/escape" },
    { type: "SymbolicLink", linkpath: "C:\\escape" },
    { type: "Link", linkpath: "repo/../../escape" },
    { type: "Link", linkpath: "other/file" },
  ] as const)("rejects unsafe archive link %j", async (entry) => {
    archiveResponse([{ path: "repo/dir/link", ...entry }]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
  });

  it("fails closed on tar's link-through-symlink containment warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    archiveResponse([
      { path: "repo/real/", type: "Directory" },
      { path: "repo/alias", type: "SymbolicLink", linkpath: "real" },
      { path: "repo/alias/secret", content: "Must not be written\n" },
    ]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
    expect(existsSync(join(dir, "real/secret"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["FIFO", "CharacterDevice", "BlockDevice", "Unsupported"] as const)("rejects %s entries", async (type) => {
    archiveResponse([{ path: "repo/special", type }]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
  });

  it("rejects multiple archive roots and duplicate or case-aliased entries", async () => {
    for (const [index, path] of ["other/file", "repo/file", "repo/FILE"].entries()) {
      archiveResponse([{ path: "repo/file", content: "One" }, { path, content: "Two" }]);
      const dest = join(dir, String(index));
      expect((await downloadTarball("acme/skills", SHA, dest)).ok).toBe(false);
    }
  });

  it("rejects aliased implicit parent directories", async () => {
    archiveResponse([
      { path: "repo/skill/SKILL.md", content: "Skill" },
      { path: "repo/SKILL/extra.sh", content: "Other directory" },
    ]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
  });

  it("bounds download lengths before reading the body", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(64 * 1024 * 1024 + 1) },
    }));
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds streamed downloads even without Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); }, cancel })));
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects declared oversized entries before writing content", async () => {
    archiveResponse([{ path: "repo/huge", size: 64 * 1024 * 1024 + 1 }]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
    expect(existsSync(join(dir, "huge"))).toBe(false);
  });

  it("bounds decompressed bytes before extraction, including padding and metadata", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    const expanded = new Transform({
      transform(_chunk, _encoding, callback) {
        for (let i = 0; i < 257; i += 1) this.push(chunk);
        callback();
      },
    });
    vi.mocked(createGunzip).mockReturnValueOnce(expanded as ReturnType<typeof createGunzip>);
    archiveResponse([{ path: "repo/file", content: "Hi" }]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
    expect(existsSync(join(dir, "file"))).toBe(false);
  });

  it("does not preserve setuid or setgid bits from archives", async () => {
    archiveResponse([{ path: "repo/script", content: "exit 0\n", mode: 0o6755 }]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(true);
    expect(lstatSync(join(dir, "script")).mode & 0o7777).toBe(0o755);
  });

  it.each([Buffer.from("invalid tar secret"), Buffer.alloc(0), archive([{ path: "repo/file", content: "Hi" }], false).subarray(0, 515)])(
    "rejects malformed or incomplete tarballs without exposing payloads", async (bytes) => {
      fetchMock.mockResolvedValue(new Response(new Uint8Array(bytes)));
      const result = await downloadTarball("acme/skills", SHA, dir);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret");
    },
  );

  it("rejects nested compression", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(gzipSync(archive([{ path: "repo/file", content: "Hi" }])))));
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
  });

  it("times out stalled tarball bodies", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(new ReadableStream()));
    const result = downloadTarball("acme/skills", SHA, dir);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toEqual({ ok: false, reason: "GitHub request timed out" });
  });

  it("does not overwrite existing destination contents", async () => {
    writeFileSync(join(dir, "existing"), "Keep\n");
    archiveResponse([{ path: "repo/existing", content: "Overwrite\n" }]);
    expect((await downloadTarball("acme/skills", SHA, dir)).ok).toBe(false);
    expect(readFileSync(join(dir, "existing"), "utf8")).toBe("Keep\n");
    expect(resolveGithubToken).toHaveBeenCalled();
  });
});
