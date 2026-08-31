import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { loadRepoCatalog } from "../src/catalog/repo.js";
import { toggle } from "../src/commands/toggle.js";
import { readLockfile } from "../src/lockfile/io.js";
import {
  disabledMcpServers,
  localConfigPath,
  setMcpEnabled,
} from "../src/providers/local-config.js";
import { writeProviders } from "../src/providers/write.js";

let dir: string;

const setup = (): string => {
  dir = mkdtempSync(join(tmpdir(), "quiver-toggle-"));
  mkdirSync(join(dir, ".agents"));
  writeFileSync(
    join(dir, ".agents", "config.json"),
    JSON.stringify({
      mcpServers: {
        context7: { transport: "http", url: "https://mcp.context7.com/mcp" },
        posthog: { transport: "http", url: "https://mcp.posthog.com/mcp" },
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
      providers: ["claude"],
      entries: {
        "mcp:context7": {
          type: "mcp",
          transport: "http",
          configDigest: "x",
          tools: null,
          toolsFetchedAt: null,
        },
        "mcp:posthog": {
          type: "mcp",
          transport: "http",
          configDigest: "x",
          tools: null,
          toolsFetchedAt: null,
        },
      },
    }),
  );
  return dir;
};

const cliOptions = (positionals: string[]): CliOptions => ({
  targetRoot: dir,
  force: false,
  all: true,
  json: false,
  verbose: false,
  accept: false,
  offline: false,
  dryRun: false,
  introspectStdio: false,
  providers: null,
  catalog: null,
  positionals,
});

const mcpJsonServers = (): string[] => {
  const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  return Object.keys(parsed.mcpServers);
};

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("local config overrides", () => {
  it("records disabled servers and prunes the file on enable", () => {
    setup();
    setMcpEnabled(dir, "posthog", false);
    expect(
      JSON.parse(readFileSync(localConfigPath(dir), "utf8")),
    ).toEqual({ mcpServers: { posthog: { enabled: false } } });
    expect([...disabledMcpServers(dir)]).toEqual(["posthog"]);

    setMcpEnabled(dir, "posthog", true);
    expect(existsSync(localConfigPath(dir))).toBe(false);
    expect(disabledMcpServers(dir).size).toBe(0);
  });
});

describe("writeProviders with disabled servers", () => {
  it("omits locally disabled servers from generated configs", () => {
    setup();
    const lock = readLockfile(dir)!;
    const { catalog } = loadRepoCatalog(dir, lock.catalog.source);

    setMcpEnabled(dir, "posthog", false);
    writeProviders(dir, catalog, lock);
    expect(mcpJsonServers()).toEqual(["context7"]);

    setMcpEnabled(dir, "posthog", true);
    writeProviders(dir, catalog, lock);
    expect(mcpJsonServers()).toEqual(["context7", "posthog"]);
  });
});

describe("toggle command", () => {
  it("disable regenerates configs without the server; enable restores it", async () => {
    setup();

    await toggle(cliOptions(["mcp:posthog"]), false);
    expect(mcpJsonServers()).toEqual(["context7"]);
    expect(existsSync(localConfigPath(dir))).toBe(true);

    await toggle(cliOptions(["mcp:posthog"]), true);
    expect(mcpJsonServers()).toEqual(["context7", "posthog"]);
    expect(existsSync(localConfigPath(dir))).toBe(false);
  });

  it("keeps the lockfile and .agents/config.json untouched", async () => {
    setup();
    const lockBefore = readFileSync(join(dir, "quiver.lock"), "utf8");
    const configBefore = readFileSync(join(dir, ".agents", "config.json"), "utf8");

    await toggle(cliOptions(["mcp:posthog"]), false);

    expect(readFileSync(join(dir, "quiver.lock"), "utf8")).toBe(lockBefore);
    expect(readFileSync(join(dir, ".agents", "config.json"), "utf8")).toBe(
      configBefore,
    );
  });

  it("rejects unknown servers and non-mcp ids", async () => {
    setup();

    await toggle(cliOptions(["mcp:unknown"]), false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    await toggle(cliOptions(["skill:cleanup"]), false);
    expect(process.exitCode).toBe(1);
  });
});
