import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { inspect } from "../src/commands/inspect.js";

let dir: string;

const setup = (): void => {
  dir = mkdtempSync(join(tmpdir(), "quiver-inspect-"));
  mkdirSync(join(dir, ".agents"));
  writeFileSync(
    join(dir, ".agents", "config.json"),
    JSON.stringify({
      mcpServers: {
        context7: { transport: "http", url: "https://mcp.context7.com/mcp" },
        linear: { transport: "http", url: "https://mcp.linear.app/mcp" },
      },
    }),
  );
  writeFileSync(
    join(dir, "quiver.lock"),
    JSON.stringify({
      version: 1,
      catalog: {
        source: "local:.agents",
        ref: null,
        resolved: null,
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
      providers: ["opencode"],
      entries: {
        "mcp:context7": {
          type: "mcp",
          transport: "http",
          configDigest: "x",
          tools: {
            "query-docs": {
              description: "Query documentation",
              inputSchemaHash: "sha256:a",
              tokens: 120,
            },
            "resolve-library-id": {
              description: "Resolve a library id",
              inputSchemaHash: "sha256:b",
              tokens: 340,
            },
          },
          toolsFetchedAt: "2026-01-02T00:00:00.000Z",
        },
        "mcp:linear": {
          type: "mcp",
          transport: "http",
          configDigest: "x",
          tools: null,
          toolsFetchedAt: null,
          authRequired: true,
        },
      },
    }),
  );
};

const cliOptions = (positionals: string[], json = true): CliOptions => ({
  targetRoot: dir,
  force: false,
  all: true,
  json,
  verbose: false,
  accept: false,
  offline: false,
  dryRun: false,
  introspectStdio: false,
  providers: null,
  catalog: null,
  positionals,
});

const jsonOutput = async (positionals: string[]): Promise<any> => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await inspect(cliOptions(positionals));
    return JSON.parse(log.mock.calls.map((c) => c.join(" ")).join("\n"));
  } finally {
    log.mockRestore();
  }
};

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("inspect", () => {
  it("reports tools sorted by token cost, most expensive first", async () => {
    setup();
    const out = await jsonOutput(["context7"]);
    expect(out.ok).toBe(true);
    expect(out.transport).toBe("http");
    expect(out.detail).toBe("https://mcp.context7.com/mcp");
    expect(out.toolCount).toBe(2);
    expect(out.tokenEstimate).toBe(460);
    expect(out.tools.map((t: { name: string }) => t.name)).toEqual([
      "resolve-library-id",
      "query-docs",
    ]);
    expect(out.tools[0]).toEqual({
      name: "resolve-library-id",
      description: "Resolve a library id",
      tokens: 340,
      inputSchemaHash: "sha256:b",
    });
  });

  it("accepts the mcp: prefix", async () => {
    setup();
    const out = await jsonOutput(["mcp:context7"]);
    expect(out.ok).toBe(true);
    expect(out.name).toBe("context7");
  });

  it("handles servers without a snapshot", async () => {
    setup();
    const out = await jsonOutput(["linear"]);
    expect(out.ok).toBe(true);
    expect(out.toolCount).toBeNull();
    expect(out.tools).toBeNull();
    expect(out.tokenEstimate).toBeNull();
    expect(out.authRequired).toBe(true);
  });

  it("rejects unknown servers and lists available ones", async () => {
    setup();
    const out = await jsonOutput(["nope"]);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unknown-server");
    expect(out.available).toEqual(["context7", "linear"]);
    expect(process.exitCode).toBe(1);
  });

  it("requires a server name", async () => {
    setup();
    const out = await jsonOutput([]);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("missing-argument");
    expect(process.exitCode).toBe(1);
  });
});
