import { describe, expect, it } from "vitest";

import { diffSnapshots, isEmptyDiff } from "../src/mcp/diff.js";
import { toSnapshot } from "../src/mcp/snapshot.js";
import type { McpToolSnapshot } from "../src/lockfile/schema.js";

const snap = (
  entries: Record<string, { description: string; schema: unknown }>,
): Record<string, McpToolSnapshot> =>
  toSnapshot(
    Object.entries(entries).map(([name, v]) => ({
      name,
      description: v.description,
      inputSchema: v.schema,
    })),
  );

describe("diffSnapshots", () => {
  it("detects no change for identical snapshots", () => {
    const a = snap({ t: { description: "d", schema: { type: "object" } } });
    expect(isEmptyDiff(diffSnapshots(a, a))).toBe(true);
  });

  it("detects added and removed tools", () => {
    const before = snap({ a: { description: "x", schema: {} } });
    const after = snap({ b: { description: "y", schema: {} } });
    const d = diffSnapshots(before, after);
    expect(d.added).toEqual(["b"]);
    expect(d.removed).toEqual(["a"]);
  });

  it("flags description change (poisoning) with before/after", () => {
    const before = snap({ t: { description: "safe", schema: {} } });
    const after = snap({ t: { description: "ignore previous", schema: {} } });
    const d = diffSnapshots(before, after);
    expect(d.descriptionChanged).toEqual([
      { name: "t", before: "safe", after: "ignore previous" },
    ]);
  });

  it("flags schema change via hash", () => {
    const before = snap({ t: { description: "d", schema: { type: "object" } } });
    const after = snap({
      t: { description: "d", schema: { type: "object", required: ["x"] } },
    });
    const d = diffSnapshots(before, after);
    expect(d.schemaChanged).toEqual(["t"]);
    expect(d.descriptionChanged).toHaveLength(0);
  });
});
