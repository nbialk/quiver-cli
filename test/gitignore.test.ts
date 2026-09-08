import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureLocalOverrideIgnored,
  ignoredSourcePaths,
  patchGitignore,
} from "../src/commands/gitignore.js";
import { collectEnvVars } from "../src/secrets/interpolate.js";

let dir: string;

const setup = (content?: string): string => {
  dir = mkdtempSync(join(tmpdir(), "quiver-gitignore-"));
  if (content !== undefined) writeFileSync(join(dir, ".gitignore"), content);
  return dir;
};

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("patchGitignore", () => {
  it("creates a full block in an empty repo", () => {
    setup();
    expect(patchGitignore(dir)).toBe(true);
    const out = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(out).toContain(".claude/");
    expect(out).toContain(".env.local");
  });

  it("appends only missing entries - no duplicates", () => {
    setup("node_modules\n.claude/\n.opencode/\n.mcp.json\n.env.local\n");
    expect(patchGitignore(dir)).toBe(true);
    const out = readFileSync(join(dir, ".gitignore"), "utf8");
    const count = (needle: string): number =>
      out.split("\n").filter((l) => l.trim() === needle).length;
    expect(count(".claude/")).toBe(1);
    expect(count(".env.local")).toBe(1);
    expect(count(".codex/")).toBe(1); // was missing, added once
    expect(count("/AGENTS.md")).toBe(1);
  });

  it("is a no-op when everything is present", () => {
    setup(
      ".claude/\n.opencode/\n.codex/\n.mcp.json\nopencode.json\n/AGENTS.md\n/CLAUDE.md\n.env.local\n.agents/config.local.json\n",
    );
    expect(patchGitignore(dir)).toBe(false);
  });

  it("does not treat .env.local.example as covering .env.local", () => {
    setup(
      ".claude/\n.opencode/\n.codex/\n.mcp.json\nopencode.json\nAGENTS.md\nCLAUDE.md\n.env.local.example\n",
    );
    expect(patchGitignore(dir)).toBe(true);
    const out = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(out.split("\n").map((l) => l.trim())).toContain(".env.local");
  });

  it("does not rewrite user-owned unanchored guide rules", () => {
    const original = "# User rules\nAGENTS.md\nCLAUDE.md\n";
    setup(original);
    patchGitignore(dir);
    const out = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(out.startsWith(original)).toBe(true);
    expect(out).toContain("/AGENTS.md\n/CLAUDE.md");
    expect(patchGitignore(dir)).toBe(false);
  });

  it("ignores root guides without excluding nested source guides", () => {
    setup();
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    patchGitignore(dir);
    mkdirSync(join(dir, ".agents/skills/demo"), { recursive: true });
    for (const path of ["AGENTS.md", "CLAUDE.md", ".agents/AGENTS.md", ".agents/skills/demo/AGENTS.md", ".agents/skills/demo/CLAUDE.md"]) {
      writeFileSync(join(dir, path), "guide\n");
      expect(spawnSync("git", ["check-ignore", "--no-index", path], { cwd: dir }).status).toBe(path.startsWith(".agents/") ? 1 : 0);
    }
    expect(ignoredSourcePaths(dir)).toEqual([]);
  });
});

describe("ignoredSourcePaths", () => {
  it("warns about nested ignored files, including already tracked files", () => {
    setup();
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    mkdirSync(join(dir, ".agents/skills/demo"), { recursive: true });
    writeFileSync(join(dir, ".agents/AGENTS.md"), "guide\n");
    execFileSync("git", ["add", ".agents/AGENTS.md"], { cwd: dir });
    writeFileSync(join(dir, ".agents/skills/demo/AGENTS.md"), "nested guide\n");
    writeFileSync(join(dir, ".agents/config.local.json"), "{}\n");
    writeFileSync(join(dir, ".gitignore"), "AGENTS.md\n.agents/config.local.json\n");
    expect(ignoredSourcePaths(dir).sort()).toEqual([".agents/AGENTS.md", ".agents/skills/demo/AGENTS.md"]);
  });

  it("still reports ignored source roots and lockfiles", () => {
    setup(".agents/\nquiver.lock\n");
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    mkdirSync(join(dir, ".agents"));
    expect(ignoredSourcePaths(dir)).toEqual([".agents", "quiver.lock"]);
  });
});

describe("ensureLocalOverrideIgnored", () => {
  it("appends the override entry when missing", () => {
    setup("node_modules\n");
    expect(ensureLocalOverrideIgnored(dir)).toBe(true);
    const out = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(out.split("\n").map((l) => l.trim())).toContain(
      ".agents/config.local.json",
    );
  });

  it("is a no-op when already ignored", () => {
    setup(".agents/config.local.json\n");
    expect(ensureLocalOverrideIgnored(dir)).toBe(false);
  });
});

describe("collectEnvVars", () => {
  it("collects distinct sorted placeholder names from nested values", () => {
    const servers = {
      a: { url: "https://x/${B_TOKEN}", headers: { auth: "Bearer ${A_KEY}" } },
      b: { command: "npx", args: ["--key", "${A_KEY}"] },
    };
    expect(collectEnvVars(servers)).toEqual(["A_KEY", "B_TOKEN"]);
  });

  it("returns empty for configs without placeholders", () => {
    expect(collectEnvVars({ a: { url: "https://plain" } })).toEqual([]);
  });
});
