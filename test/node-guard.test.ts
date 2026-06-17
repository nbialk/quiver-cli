import { describe, expect, it } from "vitest";

import {
  checkNodeForCommand,
  isBelow,
  MIN_NODE,
} from "../src/version/node-guard.js";

describe("isBelow", () => {
  it("compares by major, minor, patch", () => {
    expect(isBelow("20.11.0", "20.12.0")).toBe(true);
    expect(isBelow("20.12.0", "20.12.0")).toBe(false);
    expect(isBelow("20.12.1", "20.12.0")).toBe(false);
    expect(isBelow("18.20.8", "20.12.0")).toBe(true);
    expect(isBelow("24.13.0", "20.12.0")).toBe(false);
  });

  it("tolerates a leading v", () => {
    expect(isBelow("v20.11.0", "20.12.0")).toBe(true);
    expect(isBelow("v24.0.0", "20.12.0")).toBe(false);
  });
});

describe("checkNodeForCommand", () => {
  it("blocks interactive commands on too-old Node", () => {
    for (const cmd of ["init", "add", "remove", "rm"]) {
      const r = checkNodeForCommand(cmd, "20.11.0");
      expect(r.ok).toBe(false);
      expect(r.message).toContain(MIN_NODE);
      expect(r.message).toContain("20.11.0");
    }
  });

  it("allows interactive commands on new-enough Node", () => {
    expect(checkNodeForCommand("init", "20.12.0").ok).toBe(true);
    expect(checkNodeForCommand("add", "24.13.0").ok).toBe(true);
  });

  it("never blocks non-interactive commands, even on old Node", () => {
    for (const cmd of ["status", "list", "sync", "check", "update"]) {
      expect(checkNodeForCommand(cmd, "18.0.0").ok).toBe(true);
    }
  });
});
