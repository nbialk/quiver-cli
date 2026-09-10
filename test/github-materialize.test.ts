import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeTree } from "../src/sources/materialize.js";

describe("GitHub tree materialization", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quiver-materialize-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "skills/skybridge"), { recursive: true });
    mkdirSync(join(repo, "skills/chatgpt-app-builder/references"), { recursive: true });
    writeFileSync(join(repo, "skills/chatgpt-app-builder/references/guide.md"), "guide");
    writeFileSync(join(repo, "skills/skybridge/SKILL.md"), "skill");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const linkPath = () => join(repo, "skills/skybridge/references");
  const run = () => materializeTree(repo, join(repo, "skills/skybridge"), join(dir, "output"));

  it("copies Skybridge's sibling references as regular files without altering upstream", () => {
    symlinkSync("../chatgpt-app-builder/references", linkPath());
    run();
    expect(readFileSync(join(dir, "output/references/guide.md"), "utf8")).toBe("guide");
    expect(lstatSync(join(dir, "output/references")).isDirectory()).toBe(true);
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
  });

  it.each(["../../../outside", "/etc", "references", ".", "../.."])("rejects unsafe link %s", (target) => {
    symlinkSync(target, linkPath());
    expect(run).toThrow(/Unsafe tree entry/);
  });

  it("rejects an escape through a linked parent", () => {
    symlinkSync("../../outside", join(repo, "skills/redirect"));
    symlinkSync("../redirect/file", linkPath());
    expect(run).toThrow(/escapes repository/);
  });

  it("rejects indirect symlink cycles", () => {
    symlinkSync("../other", linkPath());
    symlinkSync("skybridge/references", join(repo, "skills/other"));
    expect(run).toThrow(/cycle/);
  });

  it("rejects dangling links", () => {
    symlinkSync("missing", linkPath());
    expect(run).toThrow();
  });
});
