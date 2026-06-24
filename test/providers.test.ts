import { describe, expect, it } from "vitest";

import {
  sameProviders,
  validateProviders,
} from "../src/providers/resolve.js";
import { formatWriteResult } from "../src/providers/write.js";

describe("validateProviders", () => {
  it("accepts a single valid provider", () => {
    expect(validateProviders(["claude"])).toEqual({ providers: ["claude"] });
  });

  it("accepts multiple valid providers preserving order", () => {
    expect(validateProviders(["opencode", "claude"])).toEqual({
      providers: ["opencode", "claude"],
    });
  });

  it("de-duplicates valid providers", () => {
    expect(validateProviders(["claude", "claude", "codex"])).toEqual({
      providers: ["claude", "codex"],
    });
  });

  it("reports unknown providers", () => {
    expect(validateProviders(["foo"])).toEqual({ invalid: ["foo"] });
  });

  it("reports only the invalid values when mixed", () => {
    expect(validateProviders(["claude", "foo", "bar"])).toEqual({
      invalid: ["foo", "bar"],
    });
  });

  it("returns an empty provider list for empty input", () => {
    expect(validateProviders([])).toEqual({ providers: [] });
  });
});

describe("sameProviders", () => {
  it("is true for identical sets regardless of order", () => {
    expect(sameProviders(["claude", "codex"], ["codex", "claude"])).toBe(true);
  });

  it("is false when lengths differ", () => {
    expect(sameProviders(["claude"], ["claude", "codex"])).toBe(false);
  });

  it("is false when members differ", () => {
    expect(sameProviders(["claude"], ["codex"])).toBe(false);
  });
});

describe("formatWriteResult", () => {
  const root = "/repo";

  it("returns no lines when nothing changed", () => {
    expect(
      formatWriteResult(root, { generated: [], linked: [], removed: [] }),
    ).toEqual([]);
  });

  it("relativizes paths against the target root", () => {
    expect(
      formatWriteResult(root, {
        generated: ["/repo/opencode.json"],
        linked: [],
        removed: [],
      }),
    ).toEqual(["  generated:", "    - opencode.json"]);
  });

  it("omits empty categories", () => {
    expect(
      formatWriteResult(root, {
        generated: ["/repo/opencode.json"],
        linked: [],
        removed: ["/repo/.opencode/skills/old"],
      }),
    ).toEqual([
      "  generated:",
      "    - opencode.json",
      "  removed:",
      "    - .opencode/skills/old",
    ]);
  });

  it("sorts paths within a category", () => {
    expect(
      formatWriteResult(root, {
        generated: [],
        linked: ["/repo/.opencode/skills/b", "/repo/.opencode/skills/a"],
        removed: [],
      }),
    ).toEqual([
      "  linked:",
      "    - .opencode/skills/a",
      "    - .opencode/skills/b",
    ]);
  });

  it("renders all three categories in order", () => {
    expect(
      formatWriteResult(root, {
        generated: ["/repo/opencode.json"],
        linked: ["/repo/.claude/skills/foo"],
        removed: ["/repo/.codex/skills/bar"],
      }),
    ).toEqual([
      "  generated:",
      "    - opencode.json",
      "  linked:",
      "    - .claude/skills/foo",
      "  removed:",
      "    - .codex/skills/bar",
    ]);
  });
});
