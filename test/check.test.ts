import { describe, expect, it } from "vitest";

import { authHint, hasCommand, summarize } from "../src/commands/check.js";

describe("summarize", () => {
  it("lists all three kinds with pluralization", () => {
    expect(summarize({ skills: 4, commands: 1, mcp: 1, plugins: 1 })).toBe(
      "4 skills, 1 command, 1 MCP server, 1 plugin",
    );
  });

  it("pluralizes counts greater than one", () => {
    expect(summarize({ skills: 2, commands: 3, mcp: 2, plugins: 2 })).toBe(
      "2 skills, 3 commands, 2 MCP servers, 2 plugins",
    );
  });

  it("omits zero counts", () => {
    expect(
      summarize({ skills: 0, commands: 1, mcp: 0, plugins: 0 }),
    ).toBe("1 command");
  });

  it("reports nothing when all counts are zero", () => {
    expect(summarize({ skills: 0, commands: 0, mcp: 0, plugins: 0 })).toBe(
      "nothing",
    );
  });
});

describe("authHint", () => {
  it("suggests the initial opencode auth when no token exists", () => {
    expect(authHint("none", "linear")).toBe(
      "requires OAuth — run 'opencode mcp auth linear', then 'quiver-cli check'",
    );
  });

  it("suggests re-auth for expired tokens", () => {
    expect(authHint("expired", "linear")).toContain("OAuth token expired");
    expect(authHint("expired", "linear")).toContain("opencode mcp auth linear");
  });

  it("suggests re-auth for rejected tokens", () => {
    expect(authHint("ok", "linear")).toContain("OAuth token rejected");
  });
});

describe("hasCommand", () => {
  it("finds commands on PATH and rejects invalid names", async () => {
    const originalPath = process.env.PATH;
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import(
      "node:fs",
    );
    const { tmpdir } = await import("node:os");
    const { join, delimiter } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "quiver-path-"));
    const cmd = "quiver-test-cmd";
    try {
      if (process.platform === "win32") {
        writeFileSync(join(dir, `${cmd}.cmd`), "@echo off\r\n");
      } else {
        const p = join(dir, cmd);
        writeFileSync(p, "#!/bin/sh\nexit 0\n");
        chmodSync(p, 0o755);
      }
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;

      expect(hasCommand(cmd)).toBe(true);
      expect(hasCommand("../node")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
