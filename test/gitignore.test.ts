import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { patchGitignore } from "../src/commands/gitignore.js";
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
    expect(count("AGENTS.md")).toBe(1);
  });

  it("is a no-op when everything is present", () => {
    setup(
      ".claude/\n.opencode/\n.codex/\n.mcp.json\nopencode.json\nAGENTS.md\nCLAUDE.md\n.env.local\n",
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
