import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { loadCatalog } from "../src/catalog/discover.js";
import { skillToEntry } from "../src/catalog/entries.js";
import { update } from "../src/commands/update.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";

const SKILL = (body: string): string =>
  `---\nname: demo\ndescription: A demo skill\n---\n${body}\n`;

let catalogDir: string | undefined;
let repoDir: string | undefined;

afterEach(() => {
  for (const dir of [catalogDir, repoDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  catalogDir = undefined;
  repoDir = undefined;
  vi.restoreAllMocks();
});

// Catalog with one skill, plus a repo whose .agents/ and lockfile are in sync
// with it. The catalog is addressed by absolute path so resolveCatalog stays
// local (no network, no package-relative lookup).
const setup = (): { source: string; skillPath: string } => {
  catalogDir = mkdtempSync(join(tmpdir(), "quiver-cat-"));
  repoDir = mkdtempSync(join(tmpdir(), "quiver-repo-"));

  mkdirSync(join(catalogDir, "skills/demo"), { recursive: true });
  writeFileSync(join(catalogDir, "skills/demo/SKILL.md"), SKILL("v1"));

  const skillPath = join(repoDir, ".agents/skills/demo/SKILL.md");
  mkdirSync(join(repoDir, ".agents/skills/demo"), { recursive: true });
  writeFileSync(skillPath, SKILL("v1"));

  const source = `local:${catalogDir}`;
  const catalog = loadCatalog({ source, root: catalogDir });
  const lock = emptyLockfile(source);
  lock.providers = ["opencode"];
  lock.entries["skill:demo"] = skillToEntry(catalog.skills[0]!);
  writeLockfile(repoDir, lock);

  return { source, skillPath };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  targetRoot: repoDir!,
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

describe("update --dry-run", () => {
  it("reports the update without touching .agents/ or the lockfile", async () => {
    const { skillPath } = setup();
    const before = readLockfile(repoDir!)!.entries["skill:demo"]!;
    writeFileSync(join(catalogDir!, "skills/demo/SKILL.md"), SKILL("v2"));

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await update(options({ dryRun: true }));
    const report = JSON.parse(log.mock.calls[0]![0] as string) as {
      dryRun: boolean;
      updated: string[];
    };

    expect(report).toMatchObject({ dryRun: true, updated: ["skill:demo"] });
    expect(readFileSync(skillPath, "utf8")).toContain("v1");
    expect(readLockfile(repoDir!)!.entries["skill:demo"]).toEqual(before);
  });

  it("applies the same update without the flag", async () => {
    const { skillPath } = setup();
    const before = readLockfile(repoDir!)!.entries["skill:demo"]!;
    writeFileSync(join(catalogDir!, "skills/demo/SKILL.md"), SKILL("v2"));

    vi.spyOn(console, "log").mockImplementation(() => {});
    await update(options());

    expect(readFileSync(skillPath, "utf8")).toContain("v2");
    expect(readLockfile(repoDir!)!.entries["skill:demo"]).not.toEqual(before);
  });

  it("still skips locally modified entries", async () => {
    const { skillPath } = setup();
    writeFileSync(join(catalogDir!, "skills/demo/SKILL.md"), SKILL("v2"));
    writeFileSync(skillPath, SKILL("local edit"));

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await update(options({ dryRun: true }));
    const report = JSON.parse(log.mock.calls[0]![0] as string) as {
      updated: string[];
      localChanges: string[];
    };

    expect(report.updated).toEqual([]);
    expect(report.localChanges).toEqual(["skill:demo"]);
  });
});
