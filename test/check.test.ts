import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { jsonDigest } from "../src/catalog/digest.js";
import { loadCatalog, type CatalogConfig } from "../src/catalog/discover.js";
import { commandToEntry, mcpToEntry, pluginToEntry, skillToEntry } from "../src/catalog/entries.js";
import { authHint, check, hasCommand, summarize } from "../src/commands/check.js";
import * as lockfile from "../src/lockfile/io.js";
import { introspect } from "../src/mcp/introspect.js";
import { findOpencodeToken } from "../src/mcp/opencode-auth.js";
import { toSnapshot } from "../src/mcp/snapshot.js";
import { checkProviders, writeProviders } from "../src/providers/write.js";
import * as ui from "../src/ui/prompts.js";

vi.mock("../src/mcp/introspect.js", () => ({ introspect: vi.fn() }));
// Source/update integration is covered in update.test.ts; this suite isolates
// local integrity, baseline acceptance and MCP observations.
vi.mock("../src/commands/update-plan.js", () => ({ checkSourceUpdates: vi.fn(async () => []) }));
vi.mock("../src/mcp/opencode-auth.js", () => ({ findOpencodeToken: vi.fn() }));
vi.mock("../src/providers/write.js", () => ({ checkProviders: vi.fn(), writeProviders: vi.fn() }));
vi.mock("../src/ui/prompts.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  block: vi.fn(),
  progress: vi.fn(async () => ({ update: vi.fn(), clear: vi.fn() })),
  palette: () => ({ cyan: (text: string) => text, dim: (text: string) => text }),
}));

const TOOLS = [{ name: "search", description: "Search records", inputSchema: { type: "object" } }];
const FETCHED_AT = "2026-01-01T00:00:00.000Z";
let repoDir: string;

const setup = () => {
  repoDir = mkdtempSync(join(tmpdir(), "quiver-check-"));
  const root = join(repoDir, ".agents");
  mkdirSync(join(root, "skills/demo"), { recursive: true });
  mkdirSync(join(root, "commands"));
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Original\nversion: v1\n---\nOriginal skill\n");
  writeFileSync(join(root, "commands/demo.md"), "Original command\n");
  writeFileSync(join(root, "plugins/demo.ts"), "export {};\n");
  const config: CatalogConfig = {
    shared: { custom: true },
    opencode: { model: "custom/model" },
    claude: { settings: { custom: true } },
    mcpServers: {
      alpha: { transport: "http", url: "https://alpha.example.test/mcp" },
      beta: { transport: "http", url: "https://beta.example.test/mcp" },
    },
    plugins: { demo: { provider: "opencode", sourcePath: "plugins/demo.ts", requires: [] } },
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(root, "config.local.json"), "{}\n");
  writeFileSync(join(root, "AGENTS.md"), "Local instructions\n");
  writeFileSync(join(repoDir, "AGENTS.md"), "Root instructions\n");
  writeFileSync(join(repoDir, "CLAUDE.md"), "Root Claude instructions\n");
  writeFileSync(join(repoDir, "opencode.json"), "{\"custom\":true}\n");
  writeFileSync(join(repoDir, ".env.local"), "# Local secrets\n");
  const catalog = loadCatalog({ source: `local:${root}`, root });
  const source = (path: string, digest: string) => ({ kind: "local" as const, root, path, digest });
  const lock = lockfile.emptyLockfile(`local:${root}`);
  lock.providers = ["opencode"];
  const skill = catalog.skills[0]!;
  const command = catalog.commands[0]!;
  const plugin = catalog.plugins[0]!;
  lock.entries["skill:demo"] = skillToEntry(skill, source(skill.sourcePath, skill.digest));
  lock.entries["command:demo"] = commandToEntry(command, source(command.sourcePath, command.digest));
  lock.entries["plugin:demo"] = pluginToEntry(plugin, source(plugin.sourcePath, plugin.digest));
  for (const mcp of catalog.mcp) {
    lock.entries[`mcp:${mcp.name}`] = {
      ...mcpToEntry(mcp, source("config.json", mcp.configDigest)),
      tools: toSnapshot(TOOLS),
      toolsFetchedAt: FETCHED_AT,
    };
  }
  lockfile.writeLockfile(repoDir, lock);
  return { root, config, catalog, lock };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  targetRoot: repoDir,
  force: false,
  all: false,
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

const projectState = () => {
  const state: Record<string, unknown> = {};
  const pending = [repoDir];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      state[relative(repoDir, path)] = {
        mtime: stat.mtimeMs,
        content: stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? null : readFileSync(path, "utf8"),
      };
      if (stat.isDirectory()) pending.push(path);
    }
  }
  return state;
};

const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);

it("shows the active MCP check before its response arrives and clears progress on completion", async () => {
  setup();
  const progress = { update: vi.fn(), clear: vi.fn() };
  vi.mocked(ui.progress).mockResolvedValueOnce(progress);
  let release!: (result: Awaited<ReturnType<typeof introspect>>) => void;
  vi.mocked(introspect).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = check(options({ json: false, positionals: ["mcp:alpha"] }));
  await vi.waitFor(() => expect(progress.update).toHaveBeenCalledWith("Checking mcp:alpha tool snapshot…"));
  expect(ui.success).not.toHaveBeenCalled();
  release({ ok: true, tools: TOOLS });
  await pending;
  expect(ui.info).toHaveBeenCalledWith("mcp:alpha: ok");
  expect(progress.clear).toHaveBeenCalled();
});

it("clears active progress on unexpected errors", async () => {
  setup();
  const progress = { update: vi.fn(), clear: vi.fn() };
  vi.mocked(ui.progress).mockResolvedValueOnce(progress);
  vi.mocked(checkProviders).mockImplementationOnce(() => { throw new Error("provider failure"); });
  await expect(check(options({ json: false }))).rejects.toThrow("provider failure");
  expect(progress.clear).toHaveBeenCalled();
});

beforeEach(() => {
  process.exitCode = 0;
  vi.clearAllMocks();
  vi.mocked(checkProviders).mockReturnValue([]);
  vi.mocked(findOpencodeToken).mockReturnValue({ status: "none" });
  vi.mocked(introspect).mockResolvedValue({ ok: true, tools: TOOLS });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  expect(writeProviders).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("check", () => {
  it("reports local content drift without changing any project files or in-memory metadata", async () => {
    const { root, lock } = setup();
    writeFileSync(join(root, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Changed\n---\nLocal skill\n");
    writeFileSync(join(root, "commands/demo.md"), "Local command\n");
    writeFileSync(join(root, "plugins/demo.ts"), "export const local = true;\n");
    const before = projectState();
    const beforeLock = structuredClone(lock);
    vi.spyOn(lockfile, "readLockfile").mockReturnValue(lock);

    await check(options());

    expect(output()).toMatchObject({ ok: false, complete: true, status: "drift", accepted: [] });
    expect(output().skillDrift.map((item: { id: string }) => item.id).sort()).toEqual(["command:demo", "plugin:demo", "skill:demo"]);
    expect(lock).toEqual(beforeLock);
    expect(projectState()).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it("checks MCP config digests and every missing artifact kind while offline", async () => {
    const { root, config } = setup();
    config.mcpServers!.alpha = { transport: "http", url: "https://changed.example.test/mcp" };
    delete config.mcpServers!.beta;
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    rmSync(join(root, "skills/demo"), { recursive: true });
    rmSync(join(root, "commands/demo.md"));
    rmSync(join(root, "plugins/demo.ts"));
    const before = projectState();

    await check(options({ offline: true }));

    expect(output()).toMatchObject({ ok: false, complete: false, configDrift: [{ id: "mcp:alpha", kind: "config" }] });
    expect(output().missing.map((item: { id: string }) => item.id).sort()).toEqual(["command:demo", "mcp:beta", "plugin:demo", "skill:demo"]);
    expect(output().mcp).toEqual([expect.objectContaining({ id: "mcp:alpha", status: "skipped", intentional: true, reason: "offline" })]);
    expect(introspect).not.toHaveBeenCalled();
    expect(findOpencodeToken).not.toHaveBeenCalled();
    expect(projectState()).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { server: { transport: "stdio", command: "run", args: ["private-value", false] }, field: "args" },
    { server: { transport: "stdio", command: "run", env: "private-value" }, field: "env" },
    { server: { transport: "http", url: "${MCP_URL}", headers: { Authorization: ["private-value"] } }, field: "headers" },
  ])("rejects malformed local MCP $field before introspection or acceptance", async ({ server, field }) => {
    const { root, config } = setup();
    writeFileSync(join(root, "config.json"), JSON.stringify({
      ...config, mcpServers: { ...config.mcpServers, alpha: server },
    }));
    const before = projectState();

    await check(options({ positionals: ["mcp:alpha"] }));
    expect(output()).toMatchObject({ ok: false, unsafe: [{ id: "mcp:alpha", reason: expect.stringContaining(`.${field} must be`) }] });
    await check(options({ positionals: ["mcp:alpha"], accept: true }));

    expect(output()).toMatchObject({ ok: false, acceptanceBlocked: true, accepted: [] });
    expect(JSON.stringify(output())).not.toContain("private-value");
    expect(projectState()).toEqual(before);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("accepts valid local MCP optional records without resolving placeholders offline", async () => {
    const { root, config } = setup();
    config.mcpServers!.alpha = { transport: "http", url: "${MCP_URL}", headers: { Authorization: "Bearer ${TOKEN}" } };
    config.mcpServers!.beta = { transport: "stdio", command: "${MCP_COMMAND}", args: ["${ARG}"], env: { TOKEN: "${TOKEN}" } };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    const configBytes = readFileSync(join(root, "config.json"), "utf8");

    await check(options({ all: true, accept: true, offline: true }));

    expect(output()).toMatchObject({ ok: true, unsafe: [], configDrift: [] });
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(configBytes);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("reports a missing plugin definition instead of silently skipping it", async () => {
    const { root, config } = setup();
    delete config.plugins!.demo;
    writeFileSync(join(root, "config.json"), JSON.stringify(config));

    await check(options({ positionals: ["plugin:demo"], offline: true }));

    expect(output().missing).toEqual([{ id: "plugin:demo", reason: expect.stringContaining("definition missing") }]);
    expect(output().ok).toBe(false);
  });

  it("does not let a same-named skill at a different path conceal a missing installed path", async () => {
    const { root } = setup();
    mkdirSync(join(root, "skills/moved"));
    renameSync(join(root, "skills/demo"), join(root, "skills/moved/demo"));
    const before = projectState();

    await check(options({ positionals: ["skill:demo"], accept: true }));

    expect(output()).toMatchObject({ ok: false, acceptanceBlocked: true, accepted: [] });
    expect(output().missing).toEqual([expect.objectContaining({ id: "skill:demo" })]);
    expect(projectState()).toEqual(before);
  });

  it("reports observed tool drift without refreshing the stored snapshot", async () => {
    setup();
    vi.mocked(introspect).mockResolvedValue({ ok: true, tools: [{ ...TOOLS[0]!, description: "Changed instructions" }] });
    const before = projectState();

    await check(options({ positionals: ["mcp:alpha"] }));

    expect(output()).toMatchObject({ ok: false, complete: true, status: "drift", accepted: [] });
    expect(output().mcp[0]).toMatchObject({ status: "drift", diff: { descriptionChanged: [{ name: "search", before: "Search records", after: "Changed instructions" }] } });
    expect(projectState()).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it("reports an absent first snapshot without writing it or claiming a healthy check", async () => {
    const { lock } = setup();
    const entry = lock.entries["mcp:alpha"]!;
    if (entry.type !== "mcp") throw new Error("Expected MCP fixture");
    entry.tools = null;
    entry.toolsFetchedAt = null;
    lockfile.writeLockfile(repoDir, lock);
    const before = projectState();

    await check(options({ positionals: ["mcp:alpha"] }));

    expect(output()).toMatchObject({ ok: false, complete: false, status: "incomplete", accepted: [] });
    expect(output().mcp).toEqual([expect.objectContaining({ id: "mcp:alpha", status: "missing-baseline", baseline: "missing" })]);
    expect(projectState()).toEqual(before);
    expect(introspect).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);

    await check(options({ positionals: ["mcp:alpha"], json: false }));
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining("quiver-cli check mcp:alpha --accept"));
    expect(ui.success).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("does not persist observed auth failures (previous flag: %s)", async (authRequired) => {
    const { lock } = setup();
    const entry = lock.entries["mcp:alpha"]!;
    if (entry.type !== "mcp") throw new Error("Expected MCP fixture");
    if (authRequired !== undefined) entry.authRequired = authRequired;
    lockfile.writeLockfile(repoDir, lock);
    const before = projectState();
    vi.mocked(introspect).mockResolvedValue({ ok: false, reason: "401", authRequired: true });

    await check(options({ positionals: ["mcp:alpha"] }));

    expect(output()).toMatchObject({ ok: false, complete: false, status: "incomplete" });
    expect(output().mcp).toEqual([expect.objectContaining({ status: "skipped", intentional: false, authRequired: true })]);
    expect(projectState()).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it("calculates missing token estimates transiently and leaves existing auth/timestamps untouched", async () => {
    const { lock } = setup();
    const entry = lock.entries["mcp:alpha"]!;
    if (entry.type !== "mcp") throw new Error("Expected MCP fixture");
    delete entry.tools!.search!.tokens;
    entry.authRequired = true;
    lockfile.writeLockfile(repoDir, lock);
    const before = projectState();

    await check(options({ positionals: ["mcp:alpha"] }));

    expect(output()).toMatchObject({ ok: true, complete: true, status: "ok" });
    expect(output().mcp[0].tokens).toBeGreaterThan(0);
    expect(projectState()).toEqual(before);
  });

  it.each([false, true])("reports unreachable introspection as incomplete (throws: %s)", async (throws) => {
    setup();
    if (throws) vi.mocked(introspect).mockRejectedValue(new Error("unreachable"));
    else vi.mocked(introspect).mockResolvedValue({ ok: false, reason: "unreachable" });
    const before = projectState();

    await check(options({ positionals: ["mcp:alpha"] }));

    expect(output()).toMatchObject({ ok: false, complete: false, status: "incomplete" });
    expect(output().mcp[0]).toMatchObject({ status: "error", reason: "unreachable" });
    expect(projectState()).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it.each(["offline", "disabled", "stdio"])("distinguishes intentional %s skips from failed introspection", async (kind) => {
    const { root, config } = setup();
    if (kind === "disabled") writeFileSync(join(root, "config.local.json"), '{"mcpServers":{"alpha":{"enabled":false}}}\n');
    if (kind === "stdio") {
      config.mcpServers!.alpha = { transport: "stdio", command: "foreign-code" };
      writeFileSync(join(root, "config.json"), JSON.stringify(config));
    }
    const before = projectState();

    await check(options({ positionals: ["mcp:alpha"], offline: kind === "offline" }));

    expect(output().complete).toBe(false);
    expect(output().mcp[0]).toMatchObject({ status: "skipped", intentional: true, baseline: "present" });
    expect(introspect).not.toHaveBeenCalled();
    expect(findOpencodeToken).not.toHaveBeenCalled();
    expect(projectState()).toEqual(before);
    if (kind !== "stdio") {
      expect(output().ok).toBe(true);
      expect(process.exitCode).toBe(0);
    } else {
      expect(output().configDrift).toHaveLength(1);
    }
  });

  it("honors stdio opt-in and reuses OAuth only for the focused HTTP server", async () => {
    const { root, config } = setup();
    vi.mocked(findOpencodeToken).mockReturnValue({ status: "ok", accessToken: "test-token" });

    await check(options({ positionals: ["mcp:alpha"] }));

    expect(findOpencodeToken).toHaveBeenCalledExactlyOnceWith("alpha", "https://alpha.example.test/mcp");
    expect(introspect).toHaveBeenCalledExactlyOnceWith(config.mcpServers!.alpha, { allowStdio: false, authToken: "test-token" });
    vi.clearAllMocks();
    config.mcpServers!.alpha = { transport: "stdio", command: "foreign-code" };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));

    await check(options({ positionals: ["mcp:alpha"], introspectStdio: true }));

    expect(findOpencodeToken).not.toHaveBeenCalled();
    expect(introspect).toHaveBeenCalledExactlyOnceWith(config.mcpServers!.alpha, { allowStdio: true, authToken: undefined });
  });

  it.each([
    { positionals: [], all: false, error: "accept-target-required" },
    { positionals: ["skill:demo", "command:demo"], all: false, error: "invalid-target" },
    { positionals: ["skill:demo"], all: true, error: "invalid-target" },
    { positionals: ["skill:unknown"], all: false, error: "not-installed" },
  ])("rejects invalid acceptance selection $positionals / --all=$all", async ({ error, ...selection }) => {
    setup();
    const before = projectState();

    await check(options({ ...selection, accept: true }));

    expect(output()).toMatchObject({ ok: false, error, accepted: [] });
    expect(projectState()).toEqual(before);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("reads V1 without migration and rejects V1 acceptance before writes", async () => {
    const { lock } = setup();
    const entries = Object.fromEntries(Object.entries(lock.entries).map(([id, entry]) => {
      const { source: _source, ...metadata } = entry;
      if ("installedPath" in metadata) {
        const { installedPath, ...rest } = metadata;
        return [id, { ...rest, sourcePath: installedPath, ...(entry.type === "skill" ? { pin: "tag:v1" } : {}) }];
      }
      return [id, metadata];
    }));
    writeFileSync(join(repoDir, "quiver.lock"), JSON.stringify({ ...lock, version: 1, entries }, null, 4) + "\n");
    const before = projectState();

    await check(options({ positionals: ["skill:demo"] }));
    expect(output()).toMatchObject({ ok: true, complete: true });
    expect(projectState()).toEqual(before);

    await check(options({ positionals: ["skill:demo"], accept: true }));
    expect(output()).toMatchObject({ ok: false, error: "accept-not-allowed", message: expect.stringContaining("migrate") });
    expect(projectState()).toEqual(before);
    expect(introspect).not.toHaveBeenCalled();
  });

  it.each(["local", "github", "legacy"] as const)("accepts only the selected local skill baseline and preserves %s provenance", async (kind) => {
    const { root, lock } = setup();
    const entry = lock.entries["skill:demo"]!;
    if (entry.type !== "skill") throw new Error("Expected skill fixture");
    if (kind === "github") entry.source = { kind, repo: "example/skills", path: "skills/demo", ref: "a".repeat(40), commit: "a".repeat(40), digest: entry.digest };
    if (kind === "legacy") entry.source = { kind, catalog: lock.catalog, sourcePath: "skills/demo", pin: "tag:v1" };
    lockfile.writeLockfile(repoDir, lock);
    writeFileSync(join(root, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Customized\nversion: v2\n---\nLocal skill\n");
    writeFileSync(join(root, "commands/demo.md"), "Unaccepted sibling edit\n");
    const before = projectState();
    const beforeLock = lockfile.readLockfile(repoDir)!;

    await check(options({ positionals: ["skill:demo"], accept: true }));

    expect(output()).toMatchObject({ ok: true, complete: true, accepted: ["skill:demo"], skillDrift: [] });
    const after = lockfile.readLockfile(repoDir)!;
    expect(after.entries["skill:demo"]).toMatchObject({ source: beforeLock.entries["skill:demo"]!.source, frontmatter: { description: "Customized", version: "v2" } });
    expect(after.entries["skill:demo"]).not.toHaveProperty("digest", entry.digest);
    for (const id of Object.keys(after.entries).filter((id) => id !== "skill:demo")) expect(after.entries[id]).toEqual(beforeLock.entries[id]);
    expect(after.catalog).toEqual(beforeLock.catalog);
    expect(after.providers).toEqual(beforeLock.providers);
    const { "quiver.lock": _beforeLock, ...beforeFiles } = before;
    const { "quiver.lock": _afterLock, ...afterFiles } = projectState();
    expect(afterFiles).toEqual(beforeFiles);
    expect(introspect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

    await check(options({ positionals: ["skill:demo"] }));
    expect(output()).toMatchObject({ ok: true, skillDrift: [], accepted: [] });
  });

  it("replaces the old snapshot after successful introspection of changed MCP config", async () => {
    const { root, config, lock } = setup();
    const entry = lock.entries["mcp:alpha"]!;
    if (entry.type !== "mcp") throw new Error("Expected MCP fixture");
    entry.authRequired = true;
    lockfile.writeLockfile(repoDir, lock);
    config.mcpServers!.alpha = { transport: "http", url: "https://changed.example.test/mcp" };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    const before = lockfile.readLockfile(repoDir)!;
    const newTools = [{ ...TOOLS[0]!, name: "new-server-search" }];
    vi.mocked(introspect).mockResolvedValueOnce({ ok: true, tools: newTools });

    await check(options({ positionals: ["mcp:alpha"], accept: true }));

    const after = lockfile.readLockfile(repoDir)!;
    expect(output()).toMatchObject({ ok: true, complete: true, accepted: ["mcp:alpha"], configDrift: [] });
    expect(after.entries["mcp:alpha"]).toMatchObject({ source: before.entries["mcp:alpha"]!.source, tools: toSnapshot(newTools), toolsFetchedAt: expect.any(String) });
    expect(after.entries["mcp:alpha"]).not.toHaveProperty("tools.search");
    expect(after.entries["mcp:alpha"]).not.toHaveProperty("toolsFetchedAt", FETCHED_AT);
    expect(after.entries["mcp:alpha"]).not.toHaveProperty("configDigest", entry.configDigest);
    expect(after.entries["mcp:alpha"]).not.toHaveProperty("authRequired");
    expect(after.entries["mcp:beta"]).toEqual(before.entries["mcp:beta"]);
    expect(introspect).toHaveBeenCalledTimes(1);
  });

  it.each(["offline", "disabled", "stdio"])("invalidates old MCP tools/auth when accepting changed config with an intentional %s skip", async (kind) => {
    const { root, config, lock } = setup();
    const entry = lock.entries["mcp:alpha"]!;
    if (entry.type !== "mcp") throw new Error("Expected MCP fixture");
    entry.authRequired = true;
    lockfile.writeLockfile(repoDir, lock);
    config.mcpServers!.alpha = kind === "stdio"
      ? { transport: "stdio", command: "new-server" }
      : { transport: "http", url: "https://new.example.test/mcp" };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    if (kind === "disabled") {
      writeFileSync(join(root, "config.local.json"), '{"mcpServers":{"alpha":{"enabled":false}}}\n');
    }
    const before = projectState();
    const selected = { positionals: ["mcp:alpha"], offline: kind === "offline" };

    await check(options(selected));
    expect(projectState()).toEqual(before);
    process.exitCode = 0;
    await check(options({ ...selected, accept: true }));

    const after = lockfile.readLockfile(repoDir)!;
    expect(after.entries["mcp:alpha"]).toMatchObject({
      source: entry.source, configDigest: jsonDigest(config.mcpServers!.alpha), tools: null, toolsFetchedAt: null,
    });
    expect(after.entries["mcp:alpha"]).not.toHaveProperty("authRequired");
    expect(after.entries["mcp:beta"]).toEqual(lock.entries["mcp:beta"]);
    expect(output().mcp[0]).toMatchObject({ status: "skipped", baseline: "missing", intentional: true });
    expect(introspect).not.toHaveBeenCalled();

    if (kind === "disabled") writeFileSync(join(root, "config.local.json"), "{}\n");
    const acceptedState = projectState();
    await check(options({ positionals: ["mcp:alpha"], introspectStdio: kind === "stdio" }));

    expect(output()).toMatchObject({ ok: false, complete: false, configDrift: [] });
    expect(output().mcp[0]).toMatchObject({ status: "missing-baseline", baseline: "missing" });
    expect(projectState()).toEqual(acceptedState);
    expect(process.exitCode).toBe(1);
  });

  it.each([false, true])("invalidates old MCP tools on changed-config failure and keeps only newly observed auth (auth failure: %s)", async (authRequired) => {
    const { root, config, lock } = setup();
    const entry = lock.entries["mcp:alpha"]!;
    if (entry.type !== "mcp") throw new Error("Expected MCP fixture");
    entry.authRequired = true;
    lockfile.writeLockfile(repoDir, lock);
    config.mcpServers!.alpha = { transport: "http", url: "https://new.example.test/mcp" };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    vi.mocked(introspect).mockResolvedValueOnce({ ok: false, reason: "Cannot connect", ...(authRequired ? { authRequired } : {}) });

    await check(options({ positionals: ["mcp:alpha"], accept: true }));

    const after = lockfile.readLockfile(repoDir)!;
    expect(after.entries["mcp:alpha"]).toMatchObject({
      source: entry.source, configDigest: jsonDigest(config.mcpServers!.alpha), tools: null, toolsFetchedAt: null,
    });
    if (authRequired) expect(after.entries["mcp:alpha"]).toHaveProperty("authRequired", true);
    else expect(after.entries["mcp:alpha"]).not.toHaveProperty("authRequired");
    expect(output()).toMatchObject({ ok: false, complete: false, accepted: ["mcp:alpha"] });
    expect(output().mcp[0]).toHaveProperty("baseline", "missing");
    expect(process.exitCode).toBe(1);
  });

  it("records observed auth metadata only on explicit acceptance, without claiming a complete check", async () => {
    setup();
    const before = lockfile.readLockfile(repoDir)!;
    vi.mocked(introspect).mockResolvedValue({ ok: false, reason: "401", authRequired: true });

    await check(options({ positionals: ["mcp:alpha"], accept: true }));

    const after = lockfile.readLockfile(repoDir)!;
    expect(output()).toMatchObject({ ok: false, complete: false, accepted: ["mcp:alpha"] });
    expect(after.entries["mcp:alpha"]).toEqual({ ...before.entries["mcp:alpha"], authRequired: true });
    expect(after.entries["mcp:beta"]).toEqual(before.entries["mcp:beta"]);
    expect(process.exitCode).toBe(1);
  });

  it("only backfills token estimates and refreshes timestamps on explicit selected acceptance", async () => {
    const { lock } = setup();
    const entry = lock.entries["mcp:alpha"]!;
    if (entry.type !== "mcp") throw new Error("Expected MCP fixture");
    delete entry.tools!.search!.tokens;
    lockfile.writeLockfile(repoDir, lock);
    const before = lockfile.readLockfile(repoDir)!;

    await check(options({ positionals: ["mcp:alpha"], accept: true }));

    const after = lockfile.readLockfile(repoDir)!;
    expect(output()).toMatchObject({ ok: true, complete: true, accepted: ["mcp:alpha"] });
    expect(after.entries["mcp:alpha"]).toMatchObject({ source: before.entries["mcp:alpha"]!.source, tools: toSnapshot(TOOLS) });
    expect(after.entries["mcp:alpha"]).not.toHaveProperty("toolsFetchedAt", FETCHED_AT);
    expect(after.entries["mcp:beta"]).toEqual(before.entries["mcp:beta"]);
  });

  it("accepts all local baselines explicitly while offline and keeps pristine source digests", async () => {
    const { root, config } = setup();
    const before = lockfile.readLockfile(repoDir)!;
    writeFileSync(join(root, "skills/demo/SKILL.md"), "Local skill\n");
    writeFileSync(join(root, "commands/demo.md"), "Local command\n");
    config.plugins!.demo!.requires = ["node"];
    config.mcpServers!.alpha = { transport: "stdio", command: "foreign-code" };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));

    await check(options({ all: true, accept: true, offline: true }));

    const after = lockfile.readLockfile(repoDir)!;
    expect(output()).toMatchObject({ ok: true, complete: false, skillDrift: [], configDrift: [] });
    expect(output().accepted.sort()).toEqual(Object.keys(before.entries).sort());
    expect(after.entries["plugin:demo"]).toHaveProperty("requires", ["node"]);
    expect(after.entries["mcp:alpha"]).toHaveProperty("transport", "stdio");
    for (const id of Object.keys(before.entries)) expect(after.entries[id]!.source).toEqual(before.entries[id]!.source);
    expect(after.entries["mcp:alpha"]).toMatchObject({ tools: null, toolsFetchedAt: null });
    expect(after.entries["mcp:beta"]).toEqual(before.entries["mcp:beta"]);
    expect(introspect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it.each(["sibling-pin", "new-entry", "config", "skill"])("aborts acceptance without overwriting a concurrent %s change during introspection", async (kind) => {
    const { root, config, lock } = setup();
    const sibling = lock.entries["skill:demo"]!;
    if (sibling.type !== "skill") throw new Error("Expected skill fixture");
    sibling.source = {
      kind: "github", repo: "example/skills", path: "skills/demo",
      ref: "a".repeat(40), commit: "a".repeat(40), digest: sibling.digest,
    };
    lockfile.writeLockfile(repoDir, lock);
    let concurrentState: ReturnType<typeof projectState>;
    vi.mocked(introspect).mockImplementationOnce(async () => {
      await Promise.resolve();
      if (kind === "sibling-pin" || kind === "new-entry") {
        const concurrentLock = lockfile.readLockfile(repoDir)!;
        if (kind === "sibling-pin") {
          const source = concurrentLock.entries["skill:demo"]!.source;
          if (source.kind !== "github") throw new Error("Expected GitHub fixture");
          source.ref = "b".repeat(40);
          source.commit = "b".repeat(40);
        } else {
          const command = concurrentLock.entries["command:demo"]!;
          if (command.type !== "command") throw new Error("Expected command fixture");
          writeFileSync(join(root, "commands/added.md"), readFileSync(join(root, "commands/demo.md")));
          concurrentLock.entries["command:added"] = {
            ...command, installedPath: "commands/added.md",
            source: { kind: "local", root, path: "commands/added.md", digest: command.digest },
          };
        }
        lockfile.writeLockfile(repoDir, concurrentLock);
      } else if (kind === "config") {
        config.mcpServers!.alpha = { transport: "http", url: "https://concurrent.example.test/mcp" };
        writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 4) + "\n");
      } else {
        writeFileSync(join(root, "skills/demo/SKILL.md"), "Concurrent skill edit\n");
      }
      concurrentState = projectState();
      return { ok: true, tools: [{ ...TOOLS[0]!, name: "uncommitted-snapshot" }] };
    });

    await check(options({ positionals: ["mcp:alpha"], accept: true }));

    expect(output()).toMatchObject({
      ok: false, complete: false, error: "concurrent-change", accepted: [],
      message: expect.stringContaining("Retry `quiver-cli check mcp:alpha --accept`"),
    });
    expect(projectState()).toEqual(concurrentState!);
    expect(lockfile.readLockfile(repoDir)!.entries["mcp:alpha"]).toEqual(lock.entries["mcp:alpha"]);
    expect(process.exitCode).toBe(1);
  });

  it("compares semantic inputs rather than lock/config formatting or key order", async () => {
    const { root, config } = setup();
    vi.mocked(introspect).mockImplementationOnce(async () => {
      await Promise.resolve();
      const concurrentLock = lockfile.readLockfile(repoDir)!;
      concurrentLock.entries = Object.fromEntries(Object.entries(concurrentLock.entries).reverse());
      writeFileSync(join(repoDir, "quiver.lock"), JSON.stringify(concurrentLock, null, 4) + "\n");
      config.mcpServers = Object.fromEntries(Object.entries(config.mcpServers!).reverse());
      writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 4) + "\n");
      return { ok: true, tools: TOOLS };
    });

    await check(options({ positionals: ["mcp:alpha"], accept: true }));

    expect(output()).toMatchObject({ ok: true, complete: true, accepted: ["mcp:alpha"] });
    expect(process.exitCode).toBe(0);
  });

  it.each(["missing", "symlink", "hardlink", "nested-symlink", "plugin-path"])("rejects acceptance of %s content without partial bulk writes", async (kind) => {
    const { root, config } = setup();
    writeFileSync(join(root, "commands/demo.md"), "Changed sibling\n");
    if (kind === "missing") rmSync(join(root, "skills/demo/SKILL.md"));
    if (kind === "symlink") {
      rmSync(join(root, "commands/demo.md"));
      symlinkSync(join(repoDir, "AGENTS.md"), join(root, "commands/demo.md"));
    }
    if (kind === "hardlink") {
      rmSync(join(root, "commands/demo.md"));
      linkSync(join(repoDir, "AGENTS.md"), join(root, "commands/demo.md"));
    }
    if (kind === "nested-symlink") symlinkSync(join(repoDir, "AGENTS.md"), join(root, "skills/demo/instructions.md"));
    if (kind === "plugin-path") {
      config.plugins!.demo!.sourcePath = "../AGENTS.md";
      writeFileSync(join(root, "config.json"), JSON.stringify(config));
    }
    const before = projectState();

    await check(options({ all: true, accept: true }));

    expect(output()).toMatchObject({ ok: false, complete: false, acceptanceBlocked: true, accepted: [] });
    expect(output()[kind === "missing" ? "missing" : "unsafe"]).toHaveLength(1);
    expect(projectState()).toEqual(before);
    expect(introspect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("keeps global provider drift visible after focused acceptance with consistent human and JSON exit codes", async () => {
    const { root } = setup();
    writeFileSync(join(root, "commands/demo.md"), "Local command\n");
    vi.mocked(checkProviders).mockReturnValue(["opencode.json differs"]);

    await check(options({ positionals: ["command:demo"], accept: true }));

    expect(output()).toMatchObject({ ok: false, accepted: ["command:demo"], skillDrift: [], shims: ["opencode.json differs"] });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await check(options({ positionals: ["command:demo"], accept: true, json: false }));
    expect(process.exitCode).toBe(1);
    expect(ui.success).not.toHaveBeenCalled();
    expect(ui.block).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining("quiver-cli sync")]));
  });
});

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
