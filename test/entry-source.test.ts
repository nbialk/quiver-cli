import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileDigest, treeDigest } from "../src/catalog/digest.js";
import { loadCatalog } from "../src/catalog/discover.js";
import { readSkillReferences } from "../src/catalog/index.js";
import { materializeCatalogEntry } from "../src/catalog/materialize.js";
import { resolveCatalog, type ResolvedCatalog } from "../src/catalog/resolve.js";
import type { EntrySource, LockEntry, SkillEntry } from "../src/lockfile/schema.js";
import { prepareCatalogEntry, prepareDirectSkill, prepareEntryUpdate, resolveCatalogId } from "../src/sources/entry.js";
import { parseGithubSource, resolveGithubDirectory } from "../src/sources/github.js";

vi.mock("../src/sources/github.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/sources/github.js")>(),
  resolveGithubDirectory: vi.fn(),
}));
vi.mock("../src/catalog/resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/catalog/resolve.js")>(),
  resolveCatalog: vi.fn(() => { throw new Error("Discovery catalog is unavailable"); }),
}));

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const OLD_DIGEST = `sha256:${"0".repeat(64)}`;
const REACT_SOURCE = "github:vercel-labs/agent-skills/skills/react-best-practices#main";
let root: string;
let commit: string;
const repositories = new Map<string, string>();

const write = (root: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const repository = (repo: string): string => {
  const path = join(root, repo);
  mkdirSync(path, { recursive: true });
  repositories.set(repo.toLowerCase(), path);
  return path;
};

const skillEntry = (source: EntrySource): SkillEntry => ({
  type: "skill", installedPath: "skills/code/my-alias", source, digest: OLD_DIGEST,
  frontmatter: { name: null, description: null, version: null },
});

const fixture = (spec = "github:nbialk/quiver-catalog/catalogs/default#Release/Next") => {
  const parsed = parseGithubSource(spec);
  const tree = repository(parsed.repo);
  const source: ResolvedCatalog = { source: spec, root: join(tree, parsed.path), ref: parsed.ref, resolved: OLD_SHA };
  write(source.root, "skills/code/cleanup/SKILL.md", "---\nname: cleanup\ndescription: Clean code\n---\n# Cleanup\n");
  write(source.root, "skills/code/cleanup/scripts/check.ts", "throw new Error('Must not execute');\n");
  write(source.root, "commands/review.md", "# Review\n");
  write(source.root, "plugins/opencode/rtk.ts", "throw new Error('Must not import');\n");
  write(source.root, "config.json", JSON.stringify({
    shared: { model: "catalog-model" },
    mcpServers: { search: { transport: "stdio", command: "must-not-run", args: ["--tools"] } },
    plugins: { rtk: { provider: "opencode", sourcePath: "plugins/opencode/rtk.ts", requires: ["rtk"] } },
  }));
  write(source.root, "catalog.json", JSON.stringify({ version: 1, skills: {
    "vercel-react-best-practices": { source: REACT_SOURCE, group: "code", description: "React performance" },
    unavailable: { source: "github:missing/unavailable/skill#main" },
  } }));
  const catalog = loadCatalog(source);
  return { source, catalog, references: readSkillReferences(source.root, catalog) };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quiver-entry-source-"));
  commit = OLD_SHA;
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
  vi.mocked(resolveGithubDirectory).mockImplementation(async (source, options) => {
    const parsed = parseGithubSource(source);
    const tree = repositories.get(parsed.repo);
    if (!tree) throw new Error(`Repository unavailable: ${parsed.repo}`);
    const directory = join(tree, parsed.path);
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Source directory not found: ${directory}`);
    }
    return {
      source, ...parsed, root: directory,
      resolved: options?.pinnedSha ?? (/^[a-f0-9]{40}$/i.test(parsed.ref ?? "") ? parsed.ref!.toLowerCase() : commit),
      fetchedAt: "2026-09-08T00:00:00.000Z",
    };
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  repositories.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveCatalogId", () => {
  it.each([
    ["cleanup", "skill:cleanup"], ["skill:cleanup", "skill:cleanup"],
    ["vercel-react-best-practices", "skill:vercel-react-best-practices"],
    ["review", "command:review"], ["search", "mcp:search"], ["rtk", "plugin:rtk"],
  ])("resolves %s to the canonical typed ID %s", (input, id) => {
    const { catalog, references } = fixture();
    expect(resolveCatalogId(input, catalog, references)).toBe(id);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it.each(["missing", "skill:review", "invalid:cleanup", "skill:../cleanup", ""])("rejects unknown ID %s", (id) => {
    const { catalog, references } = fixture();
    expect(() => resolveCatalogId(id, catalog, references)).toThrow(/Unknown catalog entry/);
  });

  it("rejects ambiguous bare names and duplicate typed IDs", () => {
    const { catalog, references } = fixture();
    catalog.commands.push({ ...catalog.commands[0]!, name: "cleanup" });
    expect(() => resolveCatalogId("cleanup", catalog, references)).toThrow(/Ambiguous.*skill:cleanup.*command:cleanup/);
    expect(resolveCatalogId("skill:cleanup", catalog, references)).toBe("skill:cleanup");
    references.push({ ...references[0]!, name: "cleanup" });
    expect(() => resolveCatalogId("skill:cleanup", catalog, references)).toThrow(/Ambiguous/);
  });
});

describe("prepareCatalogEntry", () => {
  it.each([
    ["skill:cleanup", "catalogs/default/skills/code/cleanup", "skills/cleanup"],
    ["command:review", "catalogs/default/commands/review.md", "commands/review.md"],
    ["mcp:search", "catalogs/default", undefined],
    ["plugin:rtk", "catalogs/default", "plugins/opencode/rtk.ts"],
  ])("records artifact provenance and installation path for %s", async (id, path, installedPath) => {
    const { source, catalog, references } = fixture();
    const original = structuredClone(catalog);
    const prepared = await prepareCatalogEntry(source, catalog, id!, references);
    const digest = prepared.entry.type === "mcp" ? prepared.entry.configDigest : prepared.entry.digest;
    expect(prepared.id).toBe(id);
    expect(prepared.entry.source).toEqual({ kind: "github", repo: "nbialk/quiver-catalog", path, ref: "Release/Next", commit: OLD_SHA, digest });
    if (prepared.entry.type !== "mcp") expect(prepared.entry.installedPath).toBe(installedPath);
    expect(catalog).toEqual(original);
    expect(prepared.catalog).not.toBe(catalog);
    for (const key of ["skills", "commands", "mcp", "plugins"] as const) expect(prepared.catalog[key]).not.toBe(catalog[key]);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("uses root-layout catalog paths and the requested null ref, never an observed branch", async () => {
    const { source, catalog } = fixture("github:Nbialk/Quiver-Catalog");
    source.ref = "observed-default-branch";
    const skill = await prepareCatalogEntry(source, catalog, "cleanup");
    const mcp = await prepareCatalogEntry(source, catalog, "mcp:search");
    expect(skill.entry.source).toMatchObject({ repo: "nbialk/quiver-catalog", path: "skills/code/cleanup", ref: null });
    expect(mcp.entry.source).toMatchObject({ path: "", ref: null });
  });

  it.each([
    ["skill:cleanup", "skills/old/group/cleanup"], ["command:review", "commands/old-review.md"],
  ])("preserves an existing installation path for %s without changing cached catalogs", async (id, installedPath) => {
    const { source, catalog } = fixture();
    const original = structuredClone(catalog);
    const prepared = await prepareCatalogEntry(source, catalog, id!, [], installedPath);
    expect(prepared.entry).toMatchObject({ installedPath });
    const item = id!.startsWith("skill:") ? prepared.catalog.skills[0]! : prepared.catalog.commands[0]!;
    expect(item.sourcePath).toBe(installedPath);
    if (prepared.entry.type === "skill") prepared.entry.frontmatter.name = "changed";
    expect(catalog).toEqual(original);
    expect(prepared.entry.source).toMatchObject({ digest: item.digest });
  });

  it.each([
    ["skill:cleanup", "skills/code/cleanup"], ["command:review", "commands/review.md"],
    ["mcp:search", ""], ["plugin:rtk", ""],
  ])("binds owned local %s to the explicit root and original artifact path", async (id, path) => {
    const { source, catalog } = fixture();
    source.source = `local:${source.root}`;
    const prepared = await prepareCatalogEntry(source, catalog, id!);
    expect(prepared.entry.source).toEqual({ kind: "local", root: source.root, path, digest: prepared.entry.type === "mcp" ? prepared.entry.configDigest : prepared.entry.digest });
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("prepares a selected alias directly alongside custom skills without fetching other pointers", async () => {
    const { source, catalog, references } = fixture();
    const upstream = repository("vercel-labs/agent-skills");
    write(upstream, "skills/react-best-practices/SKILL.md", "---\nname: react-best-practices\n---\n# React\n");
    write(upstream, "config.json", "invalid config must not load");
    const own = await prepareCatalogEntry(source, catalog, "cleanup", references);
    const alias = await prepareCatalogEntry(source, catalog, "vercel-react-best-practices", references);
    expect(own.entry.source).toMatchObject({ repo: "nbialk/quiver-catalog", path: "catalogs/default/skills/code/cleanup" });
    expect(alias).toMatchObject({
      id: "skill:vercel-react-best-practices",
      entry: {
        installedPath: "skills/vercel-react-best-practices",
        source: { kind: "github", repo: "vercel-labs/agent-skills", path: "skills/react-best-practices", ref: "main", commit: OLD_SHA },
        frontmatter: { name: "react-best-practices", description: null, version: null },
      },
      catalog: { config: {}, commands: [], mcp: [], plugins: [] },
    });
    expect(alias.catalog.skills[0]).toMatchObject({ name: "vercel-react-best-practices", group: "general", sourcePath: "skills/vercel-react-best-practices" });
    expect(catalog.skills.map(({ name }) => name)).toEqual(["cleanup"]);
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(REACT_SOURCE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a selected alias's existing installation path", async () => {
    const { source, catalog, references } = fixture();
    write(repository("vercel-labs/agent-skills"), "skills/react-best-practices/SKILL.md", "# React\n");
    const prepared = await prepareCatalogEntry(source, catalog, "skill:vercel-react-best-practices", references, "skills/code/vercel-react-best-practices");
    expect(prepared.entry).toMatchObject({ installedPath: "skills/code/vercel-react-best-practices" });
    expect(prepared.entry.source).toMatchObject({ path: "skills/react-best-practices" });
  });

  it("does not follow a second catalog hop when the selected pointer has no root SKILL.md", async () => {
    const { source, catalog, references } = fixture();
    const upstream = repository("vercel-labs/agent-skills");
    write(upstream, "skills/react-best-practices/catalog.json", JSON.stringify({ version: 1, skills: { nested: { source: "github:third/party/skill" } } }));
    write(upstream, "skills/react-best-practices/skills/nested/SKILL.md", "# Nested\n");
    await expect(prepareCatalogEntry(source, catalog, "skill:vercel-react-best-practices", references)).rejects.toThrow(/regular root SKILL.md/);
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(REACT_SOURCE);
  });

  it("rejects plugin relocation even if only the installed path differs", async () => {
    const { source, catalog } = fixture();
    await expect(prepareCatalogEntry(source, catalog, "plugin:rtk", [], "plugins/renamed.ts")).rejects.toThrow(/Unsupported plugin relocation.*plugins\/renamed.ts.*plugins\/opencode\/rtk.ts/);
    const prepared = await prepareCatalogEntry(source, catalog, "plugin:rtk", [], "plugins/opencode/rtk.ts");
    expect(prepared.entry).toMatchObject({ digest: catalog.plugins[0]!.digest });
  });

  it("rejects unresolved GitHub provenance rather than creating an inferred baseline", async () => {
    const { source, catalog } = fixture();
    source.resolved = null;
    await expect(prepareCatalogEntry(source, catalog, "cleanup")).rejects.toThrow(/resolved commit SHA/);
  });

  it("rejects an owned artifact path that would be reinterpreted as a requested ref", async () => {
    const { source, catalog } = fixture("github:nbialk/quiver-catalog");
    catalog.skills[0]!.sourcePath = "skills/code/cleanup#other-ref";
    await expect(prepareCatalogEntry(source, catalog, "cleanup")).rejects.toThrow(/Invalid GitHub source/);
  });
});

describe("prepareDirectSkill", () => {
  it.each([
    ["github:Acme/Skills/vendor/RemoteName#Release/Next", undefined, "RemoteName", "vendor/RemoteName"],
    ["github:Acme/Skills/vendor/RemoteName", "my-alias", "my-alias", "vendor/RemoteName"],
    ["github:Blader/Humanizer#main", undefined, "humanizer", ""],
    ["github:Blader/Humanizer", "my-alias", "my-alias", ""],
  ])("uses a directory or repository basename, with an explicit alias taking precedence: %s", async (spec, alias, name, path) => {
    const parsed = parseGithubSource(spec!);
    const tree = repository(parsed.repo);
    write(tree, [parsed.path, "SKILL.md"].filter(Boolean).join("/"), "---\nname: unrelated-frontmatter-name\n---\n# Skill\n");
    write(tree, "config.json", "invalid repository config");
    write(tree, "catalog.json", "invalid repository index");
    const prepared = await prepareDirectSkill(spec!, alias);
    expect(prepared).toMatchObject({
      id: `skill:${name}`, entry: { installedPath: `skills/${name}`, source: { kind: "github", repo: parsed.repo, path, ref: parsed.ref, commit: OLD_SHA } },
      catalog: { config: {}, commands: [], mcp: [], plugins: [] },
    });
    expect(prepared.catalog.skills).toHaveLength(1);
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(spec);
  });

  it("includes and materializes every resource without importing config or executing code", async () => {
    const tree = repository("acme/skills");
    write(tree, "selected/SKILL.md", "# Skill\n");
    write(tree, "selected/scripts/run.ts", "throw new Error('Must not run');\n");
    write(tree, "selected/assets/nested/example.bin", Buffer.from([0, 255, 42]));
    write(tree, "selected/references/guide.md", "# Resource\n");
    write(tree, "selected/config.json", "not valid JSON");
    write(tree, "selected/catalog.json", "not a catalog index");
    write(tree, "config.json", "invalid root config");
    const prepared = await prepareDirectSkill("github:acme/skills/selected", "my-alias");
    expect(prepared.entry).toMatchObject({ digest: treeDigest(join(tree, "selected")), source: { digest: treeDigest(join(tree, "selected")) } });
    expect(prepared.catalog.config).toEqual({});
    const target = join(root, "project");
    materializeCatalogEntry(target, prepared.catalog, "skill", "my-alias");
    expect(treeDigest(join(target, ".agents/skills/my-alias"))).toBe(treeDigest(join(tree, "selected")));
    expect(readFileSync(join(target, ".agents/skills/my-alias/assets/nested/example.bin"))).toEqual(Buffer.from([0, 255, 42]));
    expect(existsSync(join(target, ".agents/config.json"))).toBe(false);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["../outside", "dir/name", "__proto__", "CON", "nul.md", ""])("rejects invalid --name %s without a fetch", async (name) => {
    await expect(prepareDirectSkill("github:acme/skills", name)).rejects.toThrow(/Invalid skill name/);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });
});

describe("prepareEntryUpdate", () => {
  it.each([null, "Release/Next", OLD_SHA.toUpperCase()])("updates a direct skill independently of discovery, preserving requested ref %s", async (ref) => {
    const tree = repository("acme/skills");
    write(tree, "vendor/RemoteName/SKILL.md", "# New skill\n");
    write(tree, "vendor/RemoteName/assets/new.txt", "Updated resource\n");
    write(tree, "config.json", "unavailable discovery catalog");
    const old = skillEntry({ kind: "github", repo: "acme/skills", path: "vendor/RemoteName", ref, commit: OLD_SHA, digest: OLD_DIGEST });
    const original = structuredClone(old);
    commit = NEW_SHA;
    const prepared = await prepareEntryUpdate("skill:my-alias", old);
    const digest = treeDigest(join(tree, "vendor/RemoteName"));
    expect(prepared.entry).toMatchObject({ installedPath: old.installedPath, digest, source: { ...old.source, commit: ref === OLD_SHA.toUpperCase() ? OLD_SHA : NEW_SHA, digest } });
    expect(prepared.catalog.skills[0]).toMatchObject({ name: "my-alias", sourcePath: old.installedPath });
    expect(old).toEqual(original);
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(`github:acme/skills/vendor/RemoteName${ref === null ? "" : `#${ref}`}`);
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("treats a skill override as an authority change, preserving alias and path/ref casing", async () => {
    const tree = repository("new-owner/new-repo");
    write(tree, "Skills/UpstreamName/SKILL.md", "# Replacement\n");
    const old = skillEntry({ kind: "github", repo: "missing/old-repo", path: "old", ref: "old-ref", commit: OLD_SHA, digest: OLD_DIGEST });
    const spec = "github:New-Owner/New-Repo/Skills/UpstreamName#Release/Next";
    commit = NEW_SHA;
    const prepared = await prepareEntryUpdate("skill:my-alias", old, spec);
    expect(prepared.entry).toMatchObject({ installedPath: old.installedPath, source: { kind: "github", repo: "new-owner/new-repo", path: "Skills/UpstreamName", ref: "Release/Next", commit: NEW_SHA, digest: treeDigest(join(tree, "Skills/UpstreamName")) } });
    expect(prepared.id).toBe("skill:my-alias");
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(spec);
  });

  it.each(["commands/Review.md", "Review.md"])("resolves the parent of GitHub command file %s and reads no catalog config", async (path) => {
    const tree = repository("acme/commands");
    write(tree, path, "# New review\n");
    write(tree, "config.json", "invalid root config");
    write(tree, "commands/config.json", "invalid command directory config");
    const old: LockEntry = { type: "command", installedPath: "commands/my-review.md", digest: OLD_DIGEST, source: { kind: "github", repo: "acme/commands", path, ref: null, commit: OLD_SHA, digest: OLD_DIGEST } };
    commit = NEW_SHA;
    const prepared = await prepareEntryUpdate("command:my-review", old);
    expect(prepared.entry).toEqual({ ...old, digest: fileDigest(join(tree, path)), source: { ...old.source, commit: NEW_SHA, digest: fileDigest(join(tree, path)) } });
    expect(prepared.catalog).toMatchObject({ config: {}, skills: [], mcp: [], plugins: [], commands: [{ name: "my-review", absPath: join(tree, path), sourcePath: old.installedPath }] });
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(`github:acme/commands${path.includes("/") ? "/commands" : ""}`);
  });

  it("uses the override command file rather than the old file or the installed name", async () => {
    const tree = repository("acme/commands");
    write(tree, "NewCommands/Replacement.md", "# Replacement command\n");
    const old: LockEntry = { type: "command", installedPath: "commands/old-review.md", digest: OLD_DIGEST, source: { kind: "github", repo: "missing/old", path: "commands/old.md", ref: null, commit: OLD_SHA, digest: OLD_DIGEST } };
    const prepared = await prepareEntryUpdate("command:review", old, "github:Acme/Commands/NewCommands/Replacement.md#Release/Next");
    expect(prepared.entry).toMatchObject({ installedPath: "commands/old-review.md", source: { repo: "acme/commands", path: "NewCommands/Replacement.md", ref: "Release/Next" } });
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith("github:acme/commands/NewCommands#Release/Next");
  });

  it.each(["missing", "directory", "symlink", "hardlink"])("rejects a %s command source", async (kind) => {
    const tree = repository("acme/commands");
    write(tree, "original.md", "# Original\n");
    if (kind === "directory") mkdirSync(join(tree, "selected.md"));
    if (kind === "symlink") symlinkSync("original.md", join(tree, "selected.md"));
    if (kind === "hardlink") linkSync(join(tree, "original.md"), join(tree, "selected.md"));
    const old: LockEntry = { type: "command", installedPath: "commands/review.md", digest: OLD_DIGEST, source: { kind: "github", repo: "acme/commands", path: "selected.md", ref: null, commit: OLD_SHA, digest: OLD_DIGEST } };
    await expect(prepareEntryUpdate("command:review", old)).rejects.toThrow(/regular file|symlinked/);
  });

  it.each(["mcp:search", "plugin:rtk"])("looks up %s by its original ID in its per-entry catalog root", async (id) => {
    const { source, catalog } = fixture();
    const previous = await prepareCatalogEntry(source, catalog, id);
    if (previous.entry.type === "mcp") {
      previous.entry.tools = { search: { description: "Old tool", inputSchemaHash: OLD_DIGEST } };
      previous.entry.toolsFetchedAt = "2026-01-01T00:00:00.000Z";
      previous.entry.authRequired = true;
    }
    const original = structuredClone(previous.entry);
    commit = NEW_SHA;
    const prepared = await prepareEntryUpdate(id, previous.entry);
    expect(prepared.entry.source).toMatchObject({ repo: "nbialk/quiver-catalog", path: "catalogs/default", ref: "Release/Next", commit: NEW_SHA });
    if (prepared.entry.type === "mcp") expect(prepared.entry).toMatchObject({ tools: null, toolsFetchedAt: null });
    expect(previous.entry).toEqual(original);
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(source.source);
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it.each(["mcp:search", "plugin:rtk"])("uses the explicitly overridden catalog root for %s, with no old ref fallback", async (id) => {
    const { source, catalog } = fixture();
    const previous = await prepareCatalogEntry(source, catalog, id);
    const replacement = fixture("github:New-Owner/Catalog/AnotherRoot");
    rmSync(source.root, { recursive: true, force: true });
    commit = NEW_SHA;
    const prepared = await prepareEntryUpdate(id, previous.entry, replacement.source.source);
    expect(prepared.id).toBe(id);
    expect(prepared.entry.source).toMatchObject({ kind: "github", repo: "new-owner/catalog", path: "AnotherRoot", ref: null, commit: NEW_SHA });
    expect(resolveGithubDirectory).toHaveBeenCalledExactlyOnceWith(replacement.source.source);
  });

  it.each(["skill:cleanup", "command:review", "mcp:search", "plugin:rtk"])("updates explicit local %s without fetching or changing its root/path authority", async (id) => {
    const { source, catalog } = fixture();
    source.source = `local:${source.root}`;
    const previous = await prepareCatalogEntry(source, catalog, id);
    const oldSource = previous.entry.source;
    previous.entry.source = { ...oldSource, digest: OLD_DIGEST } as EntrySource;
    const prepared = await prepareEntryUpdate(id, previous.entry);
    expect(prepared.entry.source).toEqual(oldSource);
    if (previous.entry.type !== "mcp") expect(prepared.entry).toMatchObject({ installedPath: previous.entry.installedPath });
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("preserves a local MCP source's explicit containing root and subpath", async () => {
    const { source, catalog } = fixture();
    source.source = `local:${source.root}`;
    const previous = await prepareCatalogEntry(source, catalog, "mcp:search");
    previous.entry.source = { kind: "local", root, path: "nbialk/quiver-catalog/catalogs/default", digest: OLD_DIGEST };
    const prepared = await prepareEntryUpdate("mcp:search", previous.entry);
    expect(prepared.entry.source).toEqual({ ...previous.entry.source, digest: catalog.mcp[0]!.configDigest });
  });

  it.each(["skill:cleanup", "command:review", "mcp:search", "plugin:rtk"])("rejects legacy %s without an explicit authority override", async (id) => {
    const { source, catalog } = fixture();
    const previous = await prepareCatalogEntry(source, catalog, id);
    previous.entry.source = { kind: "legacy", catalog: { source: source.source, ref: "main", resolved: OLD_SHA, fetchedAt: "2026-01-01T00:00:00.000Z" }, sourcePath: "invented/path", pin: OLD_SHA };
    await expect(prepareEntryUpdate(id, previous.entry)).rejects.toThrow(/legacy provenance.*--source/);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ["skill:cleanup", "skills/code/cleanup"], ["command:review", "commands/review.md"],
    ["mcp:search", ""], ["plugin:rtk", ""],
  ])("migrates legacy %s only from the explicitly provided local authority", async (id, path) => {
    const { source, catalog } = fixture();
    const previous = await prepareCatalogEntry(source, catalog, id!);
    previous.entry.source = { kind: "legacy", catalog: { source: "github:missing/catalog", ref: "main", resolved: OLD_SHA, fetchedAt: "2026-01-01T00:00:00.000Z" } };
    const prepared = await prepareEntryUpdate(id!, previous.entry, `local:${join(source.root, path!)}`);
    expect(prepared.entry.source).toMatchObject({ kind: "local", digest: previous.entry.type === "mcp" ? previous.entry.configDigest : previous.entry.digest });
    if (previous.entry.type !== "mcp") expect(prepared.entry).toMatchObject({ installedPath: previous.entry.installedPath });
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("rejects a plugin whose current source config relocates its file", async () => {
    const { source, catalog } = fixture();
    const previous = await prepareCatalogEntry(source, catalog, "plugin:rtk");
    write(source.root, "plugins/new.ts", "# New plugin\n");
    write(source.root, "config.json", JSON.stringify({ plugins: { rtk: { provider: "opencode", sourcePath: "plugins/new.ts" } } }));
    await expect(prepareEntryUpdate("plugin:rtk", previous.entry)).rejects.toThrow(/Unsupported plugin relocation/);
  });

  it.each(["", "local:relative", "local:../outside", "https://github.com/acme/skills", "file:/tmp/skill", "github:acme", "github:acme/skills/../outside"])("rejects invalid source override %s", async (spec) => {
    const old = skillEntry({ kind: "local", root, path: "skill", digest: OLD_DIGEST });
    await expect(prepareEntryUpdate("skill:my-alias", old, spec)).rejects.toThrow(/Expected github:|Invalid GitHub source/);
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("rejects local source paths escaping or traversing linked source trees", async () => {
    const old = skillEntry({ kind: "local", root, path: "../escape", digest: OLD_DIGEST });
    await expect(prepareEntryUpdate("skill:my-alias", old)).rejects.toThrow(/escapes/);
    write(root, "real/skill/SKILL.md", "# Skill\n");
    symlinkSync("real", join(root, "linked"));
    old.source = { kind: "local", root, path: "linked/skill", digest: OLD_DIGEST };
    await expect(prepareEntryUpdate("skill:my-alias", old)).rejects.toThrow(/symlinked/);
  });

  it.each(["skill#injected-ref", "../escape", "path\\outside"])("rejects a stored GitHub path %s without changing its meaning", async (path) => {
    const old = skillEntry({ kind: "github", repo: "acme/skills", path, ref: null, commit: OLD_SHA, digest: OLD_DIGEST });
    await expect(prepareEntryUpdate("skill:my-alias", old)).rejects.toThrow(/Invalid GitHub source/);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("rejects an ID that disagrees with its locked entry type", async () => {
    const old = skillEntry({ kind: "local", root, path: "skill", digest: OLD_DIGEST });
    await expect(prepareEntryUpdate("command:my-alias", old)).rejects.toThrow(/Invalid entry ID/);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });
});
