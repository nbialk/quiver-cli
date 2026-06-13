import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  catalogCacheDir,
  catalogCacheRoot,
  parseGithubSource,
} from "../src/catalog/remote.js";

describe("parseGithubSource", () => {
  it("parses owner/repo", () => {
    expect(parseGithubSource("github:acme/skills")).toEqual({
      repo: "acme/skills",
      path: "",
      ref: null,
    });
  });

  it("parses a subpath", () => {
    expect(parseGithubSource("github:acme/skills/catalogs/.agents")).toEqual({
      repo: "acme/skills",
      path: "catalogs/.agents",
      ref: null,
    });
  });

  it("parses a ref", () => {
    expect(parseGithubSource("github:acme/skills#v2")).toEqual({
      repo: "acme/skills",
      path: "",
      ref: "v2",
    });
  });

  it("parses subpath and ref together", () => {
    expect(parseGithubSource("github:acme/skills/.agents#release/1.x")).toEqual({
      repo: "acme/skills",
      path: ".agents",
      ref: "release/1.x",
    });
  });

  it("throws on missing repo", () => {
    expect(() => parseGithubSource("github:acme")).toThrow(/Invalid catalog source/);
  });

  it("throws on empty ref", () => {
    expect(() => parseGithubSource("github:acme/skills#")).toThrow(/empty #ref/);
  });
});

describe("catalog cache", () => {
  const originalXdg = process.env["XDG_CACHE_HOME"];

  afterEach(() => {
    if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = originalXdg;
  });

  it("respects XDG_CACHE_HOME", () => {
    process.env["XDG_CACHE_HOME"] = "/tmp/xdg-cache";
    expect(catalogCacheRoot()).toBe(
      resolve("/tmp/xdg-cache", "quiver", "catalogs"),
    );
  });

  it("content-addresses cache dirs by repo and short sha", () => {
    process.env["XDG_CACHE_HOME"] = "/tmp/xdg-cache";
    expect(catalogCacheDir("acme/skills", "a".repeat(40))).toBe(
      resolve("/tmp/xdg-cache", "quiver", "catalogs", "acme-skills-aaaaaaaaaaaa"),
    );
  });
});
