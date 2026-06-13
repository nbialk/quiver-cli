import { describe, expect, it } from "vitest";

import { summarize } from "../src/commands/check.js";

describe("summarize", () => {
  it("lists all three kinds with pluralization", () => {
    expect(summarize({ skills: 4, commands: 1, mcp: 1 })).toBe(
      "4 skills, 1 command, 1 MCP server",
    );
  });

  it("pluralizes counts greater than one", () => {
    expect(summarize({ skills: 2, commands: 3, mcp: 2 })).toBe(
      "2 skills, 3 commands, 2 MCP servers",
    );
  });

  it("omits zero counts", () => {
    expect(summarize({ skills: 0, commands: 1, mcp: 0 })).toBe("1 command");
  });

  it("reports nothing when all counts are zero", () => {
    expect(summarize({ skills: 0, commands: 0, mcp: 0 })).toBe("nothing");
  });
});
