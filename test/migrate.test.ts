import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { migrate } from "../src/commands/migrate.js";
import { emptyLockfile, lockfilePath, readLockfile } from "../src/lockfile/io.js";
import * as ui from "../src/ui/prompts.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "quiver-migrate-"));
  roots.push(root);
  return root;
};
const v1 = () => ({
  version: 1,
  catalog: {
    source: "github:owner/old-catalog/.agents#old-release",
    ref: "old-release",
    resolved: "b".repeat(40),
    fetchedAt: "2026-01-01T00:00:00.000Z",
  },
  providers: ["opencode"],
  entries: {
    "skill:edited": {
      type: "skill",
      sourcePath: "skills/edited",
      digest: DIGEST,
      pin: "sha:old-unverified-pin",
      frontmatter: { name: "edited", description: "Description", version: "1.0" },
    },
    "command:missing": {
      type: "command",
      sourcePath: "commands/missing.md",
      digest: DIGEST,
    },
    "plugin:edited": {
      type: "plugin",
      provider: "opencode",
      sourcePath: "plugins/opencode/edited.ts",
      digest: DIGEST,
      requires: ["rtk"],
    },
    "mcp:example": {
      type: "mcp",
      transport: "http",
      configDigest: DIGEST,
      tools: {
        newer: { description: "Snapshot\nwith lines", inputSchemaHash: DIGEST, tokens: 42 },
        older: { description: "Old snapshot", inputSchemaHash: DIGEST },
      },
      toolsFetchedAt: "2026-01-02T00:00:00.000Z",
      authRequired: true,
    },
  },
});
const options = (targetRoot: string, overrides: Partial<CliOptions> = {}): CliOptions => ({
  targetRoot,
  force: false,
  all: true,
  json: true,
  verbose: false,
  accept: false,
  offline: false,
  dryRun: false,
  introspectStdio: false,
  providers: null,
  catalog: null,
  positionals: [],
  ...overrides,
});
const setup = () => {
  const root = tempRoot();
  const files = {
    ".agents/skills/edited/SKILL.md": "Locally edited skill, not its baseline.\n",
    ".agents/plugins/opencode/edited.ts": "export const local = true;\n",
    ".agents/config.json": '{"mcpServers":{"example":{"transport":"http","url":"https://local.example.test"}}}\n',
    ".opencode/opencode.json": "Local provider bytes must not be regenerated.\n",
    ".env.local": "LOCAL_FIXTURE=unchanged\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeFileSync(lockfilePath(root), JSON.stringify(v1(), null, 2) + "\n");
  return { root, files };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("migrate", () => {
  it("converts only metadata and retains local drift, missing entries, pins, and MCP snapshots", async () => {
    const { root, files } = setup();
    const paths = readdirSync(root, { recursive: true }).sort();
    const original = v1();
    const normalized = readLockfile(root)!;
    const fetch = vi.fn(() => { throw new Error("Migration must not use the network"); });
    vi.stubGlobal("fetch", fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await migrate(options(root, { force: true, accept: true, introspectStdio: true }));

    expect(process.exitCode).not.toBe(1);
    expect(readLockfile(root)).toEqual({ ...normalized, version: 2 });
    const migrated = readLockfile(root)!;
    expect(migrated.catalog).toEqual(original.catalog);
    expect(migrated.providers).toEqual(original.providers);
    expect(migrated.entries["mcp:example"]).toEqual({
      ...original.entries["mcp:example"],
      source: { kind: "legacy", catalog: original.catalog },
    });
    expect(migrated.entries["skill:edited"]).toMatchObject({
      digest: DIGEST,
      installedPath: "skills/edited",
      source: { kind: "legacy", sourcePath: "skills/edited", pin: "sha:old-unverified-pin" },
    });
    for (const [path, content] of Object.entries(files)) {
      expect(readFileSync(join(root, path), "utf8")).toBe(content);
    }
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(paths);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      ok: true,
      fromVersion: 1,
      toVersion: 2,
      dryRun: false,
      entries: Object.keys(normalized.entries).sort().map((id) => ({
        id, source: normalized.entries[id]!.source, unverified: true,
      })),
    });
  });

  it("dry-runs without project writes and lists every unverified origin", async () => {
    const { root, files } = setup();
    const before = readFileSync(lockfilePath(root));
    const stats = statSync(lockfilePath(root));
    const paths = readdirSync(root, { recursive: true }).sort();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await migrate(options(root, { dryRun: true }));

    expect(readFileSync(lockfilePath(root))).toEqual(before);
    expect(statSync(lockfilePath(root)).mtimeMs).toBe(stats.mtimeMs);
    expect(statSync(lockfilePath(root)).ino).toBe(stats.ino);
    for (const [path, content] of Object.entries(files)) {
      expect(readFileSync(join(root, path), "utf8")).toBe(content);
    }
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(paths);
    const output = JSON.parse(log.mock.calls[0]![0] as string);
    expect(output).toMatchObject({ ok: true, fromVersion: 1, toVersion: 2, dryRun: true });
    expect(output.entries).toEqual(Object.keys(v1().entries).sort().map((id) => ({
      id, source: readLockfile(root)!.entries[id]!.source, unverified: true,
    })));
  });

  it.each([false, true])("does not rewrite an already-V2 lockfile (dryRun=%s)", async (dryRun) => {
    const root = tempRoot();
    const content = JSON.stringify(emptyLockfile("local:missing-catalog"));
    writeFileSync(lockfilePath(root), content);
    const stats = statSync(lockfilePath(root));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await migrate(options(root, { dryRun }));

    expect(readFileSync(lockfilePath(root), "utf8")).toBe(content);
    expect(statSync(lockfilePath(root)).ino).toBe(stats.ino);
    expect(statSync(lockfilePath(root)).mtimeMs).toBe(stats.mtimeMs);
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      ok: true, fromVersion: 2, toVersion: 2, dryRun, entries: [],
    });
  });

  it("is idempotent after migrating a populated lockfile", async () => {
    const { root } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await migrate(options(root));
    const bytes = readFileSync(lockfilePath(root));
    const stats = statSync(lockfilePath(root));
    await migrate(options(root));
    expect(readFileSync(lockfilePath(root))).toEqual(bytes);
    expect(statSync(lockfilePath(root)).ino).toBe(stats.ino);
    expect(statSync(lockfilePath(root)).mtimeMs).toBe(stats.mtimeMs);
  });

  it.each([undefined, null])("preserves provider selection %s", async (providers) => {
    const root = tempRoot();
    writeFileSync(lockfilePath(root), JSON.stringify({ ...v1(), providers }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await migrate(options(root));
    const lock = readLockfile(root)!;
    expect(lock.version).toBe(2);
    expect(lock.providers).toBe(providers);
    expect(Object.hasOwn(lock, "providers")).toBe(providers !== undefined);
  });

  it("migrates the first shipped V1 frontmatter without guessing a version", async () => {
    const root = tempRoot();
    const original = v1();
    const entry = original.entries["skill:edited"];
    writeFileSync(lockfilePath(root), JSON.stringify({
      ...original,
      entries: {
        "skill:edited": {
          ...entry,
          frontmatter: { name: entry.frontmatter.name, description: entry.frontmatter.description },
        },
      },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await migrate(options(root));
    expect(readLockfile(root)).toMatchObject({
      version: 2,
      entries: { "skill:edited": { frontmatter: { ...entry.frontmatter, version: null } } },
    });
  });

  it("uses the UI to explain the metadata-only dry run and each unverified entry", async () => {
    const { root } = setup();
    const info = vi.spyOn(ui, "info").mockResolvedValue();
    const warn = vi.spyOn(ui, "warn").mockResolvedValue();
    const success = vi.spyOn(ui, "success").mockResolvedValue();
    await migrate(options(root, { dryRun: true, json: false }));
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/Would migrate.*No files changed/));
    expect(warn).toHaveBeenCalledTimes(4);
    for (const id of Object.keys(v1().entries)) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${id}: unverified origin`));
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sha:old-unverified-pin"));
    expect(success).not.toHaveBeenCalled();
    expect(readLockfile(root)!.version).toBe(1);
  });

  it("rejects positional arguments without reading or modifying the project", async () => {
    const root = tempRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await migrate(options(root, { positionals: ["skill:edited"] }));
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      ok: false, fromVersion: null, toVersion: 2, entries: [],
      error: expect.stringContaining("no positional arguments"),
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it("reports a missing lockfile with an init hint", async () => {
    const root = tempRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await migrate(options(root));
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      ok: false, error: expect.stringContaining("quiver-cli init"),
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    { ...v1(), version: 99 },
    { ...v1(), entries: { "command:missing": { type: "command", sourcePath: "../outside", digest: DIGEST } } },
  ])("reports invalid lockfiles without rewriting them", async (lock) => {
    const root = tempRoot();
    const content = JSON.stringify(lock);
    writeFileSync(lockfilePath(root), content);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await migrate(options(root));
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ ok: false, error: expect.any(String) });
    expect(readFileSync(lockfilePath(root), "utf8")).toBe(content);
  });
});
