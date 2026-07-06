import { describe, expect, it } from "vitest";

import { parse } from "../src/cli.js";

describe("parse", () => {
  it("defaults to the init command with no args", () => {
    const { command, unknownFlags } = parse([]);
    expect(command).toBe("init");
    expect(unknownFlags).toEqual([]);
  });

  it("accepts known boolean flags", () => {
    const { options, unknownFlags } = parse([
      "check",
      "--json",
      "--offline",
      "-V",
    ]);
    expect(unknownFlags).toEqual([]);
    expect(options.json).toBe(true);
    expect(options.offline).toBe(true);
    expect(options.verbose).toBe(true);
  });

  it("accepts known value flags", () => {
    const { options, unknownFlags } = parse([
      "init",
      "--providers=claude,opencode",
      "--catalog=github:acme/cat",
    ]);
    expect(unknownFlags).toEqual([]);
    expect(options.providers).toEqual(["claude", "opencode"]);
    expect(options.catalog).toBe("github:acme/cat");
  });

  it("reports unknown flags", () => {
    const { unknownFlags } = parse(["check", "--jsonn", "--nope"]);
    expect(unknownFlags).toEqual(["--jsonn", "--nope"]);
  });

  it("rejects a value flag written as a bare boolean flag", () => {
    const { unknownFlags } = parse(["init", "--providers"]);
    expect(unknownFlags).toEqual(["--providers"]);
  });

  it("collects positionals separately from flags", () => {
    const { command, options, unknownFlags } = parse([
      "add",
      "mcp:context7",
      "--force",
    ]);
    expect(command).toBe("add");
    expect(options.positionals).toEqual(["mcp:context7"]);
    expect(options.force).toBe(true);
    expect(unknownFlags).toEqual([]);
  });
});
