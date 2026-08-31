import { describe, expect, it } from "vitest";

import { backfillTokens, toSnapshot } from "../src/mcp/snapshot.js";
import { estimateTokens, formatTokens, sumTokens } from "../src/mcp/tokens.js";

describe("estimateTokens", () => {
  it("counts chars/4 over the canonical tool definition", () => {
    const tool = { name: "t", description: "d", inputSchema: {} };
    const canonical = '{"description":"d","inputSchema":{},"name":"t"}';
    expect(estimateTokens(tool)).toBe(Math.ceil(canonical.length / 4));
  });

  it("grows with the input schema", () => {
    const small = { name: "t", description: "d", inputSchema: {} };
    const large = {
      name: "t",
      description: "d",
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
    };
    expect(estimateTokens(large)).toBeGreaterThan(estimateTokens(small));
  });
});

describe("formatTokens", () => {
  it("shows raw counts below 1000", () => {
    expect(formatTokens(840)).toBe("~840 tok");
  });

  it("shows thousands with one decimal", () => {
    expect(formatTokens(45230)).toBe("~45.2k tok");
  });
});

describe("sumTokens", () => {
  it("sums per-tool estimates", () => {
    expect(sumTokens({ a: { tokens: 10 }, b: { tokens: 32 } })).toBe(42);
  });

  it("returns null when any tool lacks an estimate", () => {
    expect(sumTokens({ a: { tokens: 10 }, b: {} })).toBeNull();
  });
});

describe("toSnapshot", () => {
  it("records a token estimate per tool", () => {
    const snap = toSnapshot([
      { name: "t", description: "d", inputSchema: { type: "object" } },
    ]);
    expect(snap["t"]!.tokens).toBeGreaterThan(0);
  });
});

describe("backfillTokens", () => {
  it("copies estimates onto snapshots recorded before they existed", () => {
    const stored = {
      t: { description: "d", inputSchemaHash: "sha256:x" },
    };
    const current = {
      t: { description: "d", inputSchemaHash: "sha256:x", tokens: 12 },
    };
    expect(backfillTokens(stored, current)).toBe(true);
    expect(stored.t).toHaveProperty("tokens", 12);
  });

  it("leaves existing estimates untouched and reports no change", () => {
    const stored = {
      t: { description: "d", inputSchemaHash: "sha256:x", tokens: 7 },
    };
    const current = {
      t: { description: "d", inputSchemaHash: "sha256:x", tokens: 12 },
    };
    expect(backfillTokens(stored, current)).toBe(false);
    expect(stored.t.tokens).toBe(7);
  });
});
