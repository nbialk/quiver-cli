import {
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commandToEntry,
  mcpToEntry,
  pluginToEntry,
  skillToEntry,
} from "../src/catalog/entries.js";
import {
  emptyLockfile,
  lockfileExists,
  lockfilePath,
  readLockfile,
  requireV2Lockfile,
  writeLockfile,
} from "../src/lockfile/io.js";
import {
  LOCKFILE_VERSION,
  parseEntryId,
  type CatalogRef,
  type GithubEntrySource,
  type Lockfile,
} from "../src/lockfile/schema.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: vi.fn(fs.renameSync),
    writeFileSync: vi.fn(fs.writeFileSync),
  };
});

const DIGEST = `sha256:${"a".repeat(64)}`;
const SOURCE_DIGEST = `sha256:${"b".repeat(64)}`;
const SHA = "c".repeat(40);
const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "quiver-lockfile-"));
  roots.push(root);
  return root;
};
const catalog = (): CatalogRef => ({
  source: "github:owner/discovery/.agents#release",
  ref: "release",
  resolved: SHA,
  fetchedAt: "2026-01-01T00:00:00.000Z",
});
const github = (): GithubEntrySource => ({
  kind: "github",
  repo: "owner/source",
  path: ".agents/skills/example",
  ref: null,
  commit: SHA,
  digest: SOURCE_DIGEST,
});
const v1 = () => ({
  version: 1,
  catalog: catalog(),
  entries: {
    "skill:example": {
      type: "skill",
      sourcePath: "skills/group/example",
      digest: DIGEST,
      pin: "tag:v1",
      frontmatter: { name: "example", description: "Description", version: null },
    },
    "command:review": {
      type: "command",
      sourcePath: "commands/review.md",
      digest: DIGEST,
    },
    "plugin:example": {
      type: "plugin",
      provider: "opencode",
      sourcePath: "plugins/opencode/example.ts",
      digest: DIGEST,
      requires: ["rtk"],
    },
    "mcp:example": {
      type: "mcp",
      transport: "http",
      configDigest: DIGEST,
      tools: {
        newer: { description: "Multiple\nlines", inputSchemaHash: DIGEST, tokens: 17 },
        older: { description: "", inputSchemaHash: SOURCE_DIGEST },
        zero: { description: "Zero cost", inputSchemaHash: DIGEST, tokens: 0 },
      },
      toolsFetchedAt: "2026-01-02T00:00:00.000Z",
      authRequired: true,
    },
  },
});
const v2 = (): Lockfile => ({
  version: 2,
  catalog: catalog(),
  providers: ["opencode", "claude"],
  entries: {
    "skill:example": {
      type: "skill",
      installedPath: "skills/group/example",
      digest: DIGEST,
      frontmatter: { name: "example", description: "Description", version: null },
      source: github(),
    },
    "mcp:example": {
      ...v1().entries["mcp:example"],
      type: "mcp",
      transport: "http",
      source: { kind: "legacy", catalog: catalog() },
    },
  },
});
const fixture = (value: unknown): string => {
  const root = tempRoot();
  writeFileSync(lockfilePath(root), JSON.stringify(value, null, 2) + "\n");
  return root;
};

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("lockfile V2", () => {
  it("creates V2 locks and returns null for absent files without writing", () => {
    const root = tempRoot();
    expect(LOCKFILE_VERSION).toBe(2);
    expect(emptyLockfile("local:.agents")).toMatchObject({
      version: 2,
      catalog: { source: "local:.agents", ref: null, resolved: null },
      entries: {},
    });
    expect(readLockfile(root)).toBeNull();
    expect(lockfileExists(root)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("normalizes all V1 entries without writing or verifying their origins", () => {
    const original = v1();
    const root = fixture(original);
    const before = readFileSync(lockfilePath(root));
    const stats = statSync(lockfilePath(root));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(writeFileSync).mockClear();

    const lock = readLockfile(root)!;

    expect(lock.version).toBe(1);
    expect(lock.catalog).toEqual(original.catalog);
    expect(lock).not.toHaveProperty("providers");
    for (const [id, entry] of Object.entries(lock.entries)) {
      expect(entry.source).toMatchObject({ kind: "legacy", catalog: original.catalog });
      expect(entry).not.toHaveProperty("sourcePath");
      expect(entry).not.toHaveProperty("pin");
      if (entry.type !== "mcp") {
        expect(entry.digest).toBe(DIGEST);
        expect(entry.source).toHaveProperty("sourcePath", entry.installedPath);
      }
    }
    expect(lock.entries["skill:example"]!.source).toHaveProperty("pin", "tag:v1");
    expect(lock.entries["mcp:example"]).toEqual({
      ...original.entries["mcp:example"],
      source: { kind: "legacy", catalog: original.catalog },
    });
    lock.catalog.ref = "changed-discovery";
    expect(lock.entries["skill:example"]!.source).toHaveProperty("catalog.ref", "release");
    expect(readFileSync(lockfilePath(root))).toEqual(before);
    expect(statSync(lockfilePath(root)).mtimeMs).toBe(stats.mtimeMs);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
  });

  it.each([undefined, null, "sha:abc123"])("preserves the old pin %s", (pin) => {
    const original = v1();
    const root = fixture({
      ...original,
      entries: { "skill:example": { ...original.entries["skill:example"], pin } },
    });
    const source = readLockfile(root)!.entries["skill:example"]!.source;
    if (pin === undefined) expect(source).not.toHaveProperty("pin");
    else expect(source).toHaveProperty("pin", pin);
  });

  it("normalizes V1 frontmatter predating the optional version metadata", () => {
    const original = v1();
    const root = fixture({
      ...original,
      entries: {
        "skill:example": {
          ...original.entries["skill:example"],
          frontmatter: { name: "example", description: null },
        },
      },
    });
    const before = readFileSync(lockfilePath(root));
    const lock = readLockfile(root)!;
    expect(lock.entries["skill:example"]).toHaveProperty("frontmatter", {
      name: "example", description: null, version: null,
    });
    expect(readFileSync(lockfilePath(root))).toEqual(before);
    writeLockfile(root, { ...lock, version: 2 });
    expect(readLockfile(root)!.entries).toEqual(lock.entries);
  });

  it.each([undefined, null, [], ["opencode", "claude"]])(
    "preserves optional provider selection %j through migration and roundtrip",
    (providers) => {
      const root = fixture({ ...v1(), providers });
      const lock = readLockfile(root)!;
      lock.version = 2;
      writeLockfile(root, lock);
      const reread = readLockfile(root)!;
      expect(reread.providers).toEqual(providers);
      expect(Object.hasOwn(reread, "providers")).toBe(providers !== undefined);
    },
  );

  it.each([undefined, false, true])("preserves optional authRequired %s and null snapshots", (authRequired) => {
    const root = fixture({
      ...v1(),
      entries: {
        "mcp:example": {
          type: "mcp",
          transport: "stdio",
          configDigest: DIGEST,
          tools: null,
          toolsFetchedAt: null,
          authRequired,
        },
      },
    });
    const lock = readLockfile(root)!;
    writeLockfile(root, { ...lock, version: 2 });
    expect(readLockfile(root)!.entries).toEqual(lock.entries);
    expect(Object.hasOwn(lock.entries["mcp:example"]!, "authRequired")).toBe(authRequired !== undefined);
  });

  it("refuses implicit V1 writes before touching the destination", () => {
    const root = fixture(v1());
    const before = readFileSync(lockfilePath(root));
    const lock = readLockfile(root)!;
    expect(() => requireV2Lockfile(lock)).toThrow(/quiver-cli migrate/);
    expect(() => writeLockfile(root, lock)).toThrow(/quiver-cli migrate/);
    expect(readFileSync(lockfilePath(root))).toEqual(before);
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
    expect(() => requireV2Lockfile(v2())).not.toThrow();
  });

  it("serializes deterministically, including nested snapshots, without mutating its input", () => {
    const root = tempRoot();
    const lock = v2();
    const original = structuredClone(lock);
    writeLockfile(root, lock);
    const first = readFileSync(lockfilePath(root), "utf8");
    const reversed = JSON.parse(first, (_key, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).reverse());
    }) as Lockfile;
    writeLockfile(root, reversed);
    expect(readFileSync(lockfilePath(root), "utf8")).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(readLockfile(root)).toEqual(original);
    expect(lock).toEqual(original);
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
    const [temp, destination] = vi.mocked(renameSync).mock.calls[0]!;
    expect(dirname(String(temp))).toBe(root);
    expect(String(temp)).toContain("quiver.lock.tmp-");
    expect(destination).toBe(lockfilePath(root));
  });

  it("keeps source provenance independent from locally accepted digests", () => {
    const root = tempRoot();
    const lock = v2();
    const skill = lock.entries["skill:example"]!;
    if (skill.type !== "skill") throw new Error("Expected skill fixture");
    skill.digest = `sha256:${"d".repeat(64)}`;
    writeLockfile(root, lock);
    expect(readLockfile(root)!.entries["skill:example"]).toMatchObject({
      digest: skill.digest,
      source: { digest: SOURCE_DIGEST, ref: null, commit: SHA },
    });
  });

  it.each(["", "nested/source.md"])("accepts explicit absolute local origins with path %j", (path) => {
    const root = tempRoot();
    const lock = v2();
    lock.entries["skill:example"]!.source = { kind: "local", root, path, digest: SOURCE_DIGEST };
    writeLockfile(root, lock);
    expect(readLockfile(root)).toEqual(lock);
  });

  it("can read absolute local provenance from another platform without resolving it", () => {
    const lock = v2();
    lock.entries["skill:example"]!.source = {
      kind: "local", root: "C:\\catalog", path: "skills\\example", digest: DIGEST,
    };
    expect(readLockfile(fixture(lock))).toEqual(lock);
  });

  it.each([null, "main", "feature/branch", SHA])("roundtrips GitHub ref %j", (ref) => {
    const root = tempRoot();
    const lock = v2();
    lock.entries["skill:example"]!.source = { ...github(), ref, path: "" };
    writeLockfile(root, lock);
    expect(readLockfile(root)).toEqual(lock);
  });
});

describe("lockfile validation", () => {
  it.each([null, [], "lockfile", 42])("rejects non-object JSON %j", (value) => {
    expect(() => readLockfile(fixture(value))).toThrow(/Invalid quiver.lock.*must be an object/);
  });

  it.each([undefined, 0, 3, "2"])("rejects unsupported version %s", (version) => {
    expect(() => readLockfile(fixture({ ...v1(), version }))).toThrow(/Unsupported quiver.lock version.*Upgrade quiver-cli/);
  });

  it("reports malformed JSON with a repair hint", () => {
    const root = tempRoot();
    writeFileSync(lockfilePath(root), '{"version":');
    expect(() => readLockfile(root)).toThrow(/Invalid JSON.*Fix the JSON syntax/);
  });

  it.each([
    { catalog: null },
    { catalog: { ...catalog(), resolved: "abc123" } },
    { catalog: { ...catalog(), source: 1 } },
    { catalog: { ...catalog(), ref: false } },
    { providers: "opencode" },
    { providers: ["unknown"] },
    { entries: [] },
    { entries: { "skill:example": null } },
    { entries: { "skill:example": { type: "command" } } },
  ])("rejects invalid lockfile shape %j", (patch) => {
    expect(() => readLockfile(fixture({ ...v2(), ...patch }))).toThrow(/Invalid quiver.lock.*(Fix this field|restore)/);
  });

  it.each(["skill:", "other:name", "skill:..", "skill:../escape", "skill:dir/name", "skill:dir\\name", "mcp:bad\nname", "mcp:__proto__", "command:C:escape"])(
    "rejects unsafe or invalid entry id %j",
    (id) => {
      expect(parseEntryId(id)).toBeNull();
      const lock = v2();
      expect(() => readLockfile(fixture({ ...lock, entries: { [id]: lock.entries["skill:example"] } }))).toThrow(/safe single-segment name/);
    },
  );

  it.each(["", ".", "..", "../escape", "skills/../../escape", "/tmp/escape", "C:\\escape", "C:escape", "skills\\..\\escape", "skills/a\0b"])(
    "rejects unsafe installed and legacy paths %j",
    (path) => {
      const old = v1();
      expect(() => readLockfile(fixture({
        ...old,
        entries: { "command:review": { ...old.entries["command:review"], sourcePath: path } },
      }))).toThrow(/sourcePath.*relative path/);
      const lock = v2();
      expect(() => readLockfile(fixture({
        ...lock,
        entries: { "skill:example": { ...lock.entries["skill:example"], installedPath: path } },
      }))).toThrow(/installedPath.*relative path/);
    },
  );

  it.each([
    undefined,
    { kind: "unknown" },
    { ...github(), repo: "../repo" },
    { ...github(), repo: "owner/repo/extra" },
    { ...github(), path: "../escape" },
    { ...github(), commit: "abc123" },
    { ...github(), ref: "" },
    { ...github(), ref: "d".repeat(40) },
    { ...github(), digest: "sha256:abc" },
    { kind: "local", root: "relative/root", path: "", digest: DIGEST },
    { kind: "local", root: "/catalog", path: "../escape", digest: DIGEST },
    { kind: "legacy", catalog: null },
    { kind: "legacy", catalog: catalog(), sourcePath: "../escape" },
    { kind: "legacy", catalog: catalog(), pin: 42 },
  ])("rejects invalid source provenance %j", (source) => {
    const lock = v2();
    expect(() => readLockfile(fixture({
      ...lock,
      entries: { "skill:example": { ...lock.entries["skill:example"], source } },
    }))).toThrow(/Invalid quiver.lock.*source/);
  });

  it.each([
    { digest: "sha256:abc" },
    { digest: "g".repeat(64) },
    { frontmatter: null },
    { frontmatter: { name: 42, description: null, version: null } },
    { sourcePath: "skills/example" },
    { pin: null },
    { modified: true },
  ])("rejects invalid V2 skill metadata %j before writing", (patch) => {
    const lock = v2();
    const root = fixture(lock);
    const before = readFileSync(lockfilePath(root));
    const invalid = {
      ...lock,
      entries: { "skill:example": { ...lock.entries["skill:example"], ...patch } },
    } as Lockfile;
    expect(() => writeLockfile(root, invalid)).toThrow(/Invalid quiver.lock/);
    expect(readFileSync(lockfilePath(root))).toEqual(before);
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
  });

  it.each([
    { transport: "socket" },
    { configDigest: "invalid" },
    { tools: [] },
    { tools: { bad: null } },
    { tools: { bad: { description: 42, inputSchemaHash: DIGEST } } },
    { tools: { bad: { description: "", inputSchemaHash: "invalid" } } },
    { tools: { bad: { description: "", inputSchemaHash: DIGEST, tokens: -1 } } },
    { tools: { bad: { description: "", inputSchemaHash: DIGEST, tokens: 1.5 } } },
    { authRequired: "true" },
    { toolsFetchedAt: 42 },
  ])("rejects invalid MCP metadata %j", (patch) => {
    const lock = v2();
    expect(() => readLockfile(fixture({
      ...lock,
      entries: { "mcp:example": { ...lock.entries["mcp:example"], ...patch } },
    }))).toThrow(/Invalid quiver.lock/);
  });
});

describe("atomic lockfile writes", () => {
  it("preserves the original and cleans up the sibling temp if rename fails", () => {
    const root = fixture(v2());
    const before = readFileSync(lockfilePath(root));
    vi.mocked(renameSync).mockImplementationOnce(() => {
      expect(readFileSync(lockfilePath(root))).toEqual(before);
      throw new Error("simulated rename failure");
    });
    expect(() => writeLockfile(root, emptyLockfile("local:.agents"))).toThrow("simulated rename failure");
    expect(readFileSync(lockfilePath(root))).toEqual(before);
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
  });

  it("closes and removes a partially written temp without truncating the lockfile", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = fixture(v2());
    const before = readFileSync(lockfilePath(root));
    let descriptor = -1;
    vi.mocked(writeFileSync).mockImplementationOnce((fd) => {
      descriptor = fd as number;
      fs.writeFileSync(fd, "partial");
      throw new Error("simulated disk full");
    });
    expect(() => writeLockfile(root, v2())).toThrow("simulated disk full");
    expect(readFileSync(lockfilePath(root))).toEqual(before);
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
    expect(() => fstatSync(descriptor)).toThrow(/EBADF/);
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "rejects symlink destinations, including dangling links (%s)",
    (dangling) => {
      const root = tempRoot();
      const outside = tempRoot();
      const destination = join(outside, "lock");
      if (!dangling) writeFileSync(destination, "keep\n");
      symlinkSync(destination, lockfilePath(root));
      expect(() => writeLockfile(root, v2())).toThrow(/symlink/);
      expect(lstatSync(lockfilePath(root)).isSymbolicLink()).toBe(true);
      expect(readdirSync(root)).toEqual(["quiver.lock"]);
      expect(readdirSync(outside)).toEqual(dangling ? [] : ["lock"]);
      if (!dangling) expect(readFileSync(destination, "utf8")).toBe("keep\n");
    },
  );

  it.skipIf(process.platform === "win32")("rejects a symlinked target root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const target = join(root, "project");
    symlinkSync(outside, target, "dir");
    expect(() => writeLockfile(target, v2())).toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("cleans up if an existing directory prevents replacing the lockfile", () => {
    const root = tempRoot();
    mkdirSync(lockfilePath(root));
    writeFileSync(join(lockfilePath(root), "keep"), "keep\n");
    expect(() => writeLockfile(root, v2())).toThrow();
    expect(readFileSync(join(lockfilePath(root), "keep"), "utf8")).toBe("keep\n");
    expect(readdirSync(root)).toEqual(["quiver.lock"]);
  });
});

describe("entry converters", () => {
  it("requires explicit provenance and retains separate installed paths and local baselines", () => {
    const source = github();
    const root = tempRoot();
    const frontmatter = { name: "example", description: null, version: null };
    const skill = skillToEntry({
      name: "example", group: "group", sourcePath: "skills/group/example",
      absDir: join(root, "skills/group/example"), digest: DIGEST, frontmatter,
    }, source);
    const command = commandToEntry({
      name: "review", sourcePath: "commands/review.md",
      absPath: join(root, "commands/review.md"), digest: DIGEST,
    }, source);
    const plugin = pluginToEntry({
      name: "example", provider: "opencode", sourcePath: "plugins/example.ts",
      absPath: join(root, "plugins/example.ts"), digest: DIGEST, requires: ["rtk"],
    }, source);
    const mcp = mcpToEntry({
      name: "example", server: { transport: "http", url: "https://example.test/mcp" },
      configDigest: DIGEST,
    }, source);
    expect(skill).toEqual({
      type: "skill", installedPath: "skills/group/example", source, digest: DIGEST, frontmatter,
    });
    expect(command).toEqual({ type: "command", installedPath: "commands/review.md", source, digest: DIGEST });
    expect(plugin).toEqual({
      type: "plugin", provider: "opencode", installedPath: "plugins/example.ts", source, digest: DIGEST, requires: ["rtk"],
    });
    expect(mcp).toEqual({
      type: "mcp", source, transport: "http", configDigest: DIGEST, tools: null, toolsFetchedAt: null,
    });
  });
});
