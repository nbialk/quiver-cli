import { describe, expect, it } from "vitest";

import { canonicalJson, jsonDigest } from "../src/catalog/digest.js";
import { readFrontmatter } from "../src/catalog/frontmatter.js";

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
