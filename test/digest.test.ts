import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, fileDigest, jsonDigest, treeDigest } from "../src/catalog/digest.js";

let dir: string;
const files: Record<string, string> = {
  "SKILL.md": "# Skill\n", "scripts/run.sh": "exit 0\n", "scripts-more.txt": "Resource\n",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quiver-digest-"));
  mkdirSync(join(dir, "scripts"));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.doUnmock("node:path");
  vi.resetModules();
});

const v1Digest = (): string => {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path).update("\0");
    hash.update(createHash("sha256").update(files[path]!).digest()).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
};

describe("treeDigest", () => {
  it("preserves the V1 POSIX recipe, including binary content hashes and sort order", () => {
    expect(treeDigest(dir)).toBe(v1Digest());
  });

  it("normalizes Windows relative paths before sorting and hashing", async () => {
    vi.doMock("node:path", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:path")>();
      return {
        ...actual, sep: "\\",
        relative: (from: string, to: string) => actual.relative(from, to).split(actual.sep).join("\\"),
      };
    });
    vi.resetModules();
    const portable = await import("../src/catalog/digest.js");
    expect(portable.treeDigest(dir)).toBe(v1Digest());
  });

  it("hashes all resources, independent of tree location", () => {
    const before = treeDigest(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/data.bin"), Buffer.from([0, 255, 128, 0]));
    expect(treeDigest(dir)).not.toBe(before);
    const withResource = treeDigest(dir);
    writeFileSync(join(dir, "assets/data.bin"), Buffer.from([0, 255, 128, 1]));
    expect(treeDigest(dir)).not.toBe(withResource);
  });

  it("does not hash modes or empty directories", () => {
    const before = treeDigest(dir);
    chmodSync(join(dir, "scripts/run.sh"), 0o755);
    mkdirSync(join(dir, "empty"));
    expect(treeDigest(dir)).toBe(before);
  });

  it.each(["file", "directory", "dangling", "escape"])("rejects %s symlink drift instead of omitting it", (kind) => {
    const target = kind === "file" ? "SKILL.md" : kind === "directory" ? "scripts" : kind === "escape" ? "../outside" : "missing";
    symlinkSync(target, join(dir, "link"));
    expect(() => treeDigest(dir)).toThrow(/Unsafe tree entry/);
  });

  it("rejects a linked tree root", () => {
    symlinkSync("scripts", join(dir, "alias"));
    expect(() => treeDigest(join(dir, "alias"))).toThrow(/regular directory/);
  });

  it("rejects hardlink drift", () => {
    linkSync(join(dir, "SKILL.md"), join(dir, "hardlink"));
    expect(() => treeDigest(dir)).toThrow(/Unsafe tree entry/);
  });

  it.skipIf(process.platform === "win32")("rejects special files without reading or blocking", () => {
    expect(spawnSync("mkfifo", [join(dir, "fifo")]).status).toBe(0);
    expect(() => treeDigest(dir)).toThrow(/Unsafe tree entry/);
  });
});

describe("existing digest APIs", () => {
  it("preserves fileDigest", () => {
    expect(fileDigest(join(dir, "SKILL.md"))).toBe(
      `sha256:${createHash("sha256").update(files["SKILL.md"]!).digest("hex")}`,
    );
  });

  it("preserves canonical JSON and nested key sorting", () => {
    expect(canonicalJson({ b: [null, { d: 1, c: true }], a: "x" })).toBe('{"a":"x","b":[null,{"c":true,"d":1}]}');
    expect(jsonDigest({ b: { d: 1, c: true }, a: "x" })).toBe(jsonDigest({ a: "x", b: { c: true, d: 1 } }));
  });
});
