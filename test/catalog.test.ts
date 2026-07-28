import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, jsonDigest } from "../src/catalog/digest.js";
import { loadCatalog } from "../src/catalog/discover.js";
import { readFrontmatter } from "../src/catalog/frontmatter.js";

let catalogDir: string | undefined;

afterEach(() => {
  if (catalogDir) rmSync(catalogDir, { recursive: true, force: true });
  catalogDir = undefined;
});

describe("readFrontmatter", () => {
  it("parses top-level scalars and strips quotes", () => {
    const fm = readFrontmatter(
      `---\nname: my-skill\ndescription: "Does a thing"\n---\nbody`,
    );
    expect(fm).toEqual({ name: "my-skill", description: "Does a thing" });
  });

  it("returns empty when no frontmatter block", () => {
    expect(readFrontmatter("# Heading\nno frontmatter")).toEqual({});
  });

  it("ignores nested/indented keys", () => {
    const fm = readFrontmatter(`---\nname: x\nmeta:\n  nested: y\n---\n`);
    expect(fm).toEqual({ name: "x", meta: "" });
  });
});

describe("digest", () => {
  it("canonicalises object keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("produces stable jsonDigest regardless of key order", () => {
    expect(jsonDigest({ a: 1, b: 2 })).toBe(jsonDigest({ b: 2, a: 1 }));
  });
});

describe("loadCatalog", () => {
  it("discovers configured local plugins", () => {
    catalogDir = mkdtempSync(join(tmpdir(), "quiver-catalog-"));
    mkdirSync(join(catalogDir, "plugins/opencode"), { recursive: true });
    writeFileSync(
      join(catalogDir, "plugins/opencode/rtk.ts"),
      "export const plugin = async () => ({});\n",
    );
    writeFileSync(
      join(catalogDir, "config.json"),
      JSON.stringify({
        plugins: {
          rtk: {
            provider: "opencode",
            sourcePath: "plugins/opencode/rtk.ts",
            requires: ["rtk"],
          },
        },
      }),
    );

    const catalog = loadCatalog({ source: "local:test", root: catalogDir });
    expect(catalog.plugins).toMatchObject([
      {
        name: "rtk",
        provider: "opencode",
        sourcePath: "plugins/opencode/rtk.ts",
        requires: ["rtk"],
      },
    ]);
  });
});
