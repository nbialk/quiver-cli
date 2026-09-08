import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, posix, resolve } from "node:path";

import { fileDigest } from "../catalog/digest.js";
import { loadCatalog, type Catalog } from "../catalog/discover.js";
import { commandToEntry, mcpToEntry, pluginToEntry, skillToEntry } from "../catalog/entries.js";
import type { SkillReference } from "../catalog/index.js";
import type { ResolvedCatalog } from "../catalog/resolve.js";
import { isCommitSha } from "../github/api.js";
import { parseEntryId, type EntrySource, type LockEntry } from "../lockfile/schema.js";
import { assertSafeMutationPath, resolveContainedPath } from "../path.js";
import { parseGithubSource, resolveGithubDirectory, type GithubSpec } from "./github.js";
import { loadSkillDirectory } from "./skill.js";

export interface PreparedEntry {
  id: string;
  entry: LockEntry;
  catalog: Catalog;
}

const githubSource = ({ repo, path, ref }: GithubSpec): string => {
  const source = `github:${repo}${path ? `/${path}` : ""}${ref === null ? "" : `#${ref}`}`;
  const parsed = parseGithubSource(source);
  if (parsed.repo !== repo.toLowerCase() || parsed.path !== path || parsed.ref !== ref) {
    throw new Error("Invalid GitHub source: repository, path and requested ref must remain distinct.");
  }
  return source;
};

const localRoot = (spec: string): string => {
  const root = spec.slice("local:".length);
  if (!spec.startsWith("local:") || !isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)) {
    throw new Error("Expected github:owner/repo[/path][#ref] or local:/absolute/path.");
  }
  return root;
};

const sourcePath = (root: string, path: string): string => {
  if (!isAbsolute(root)) throw new Error("Source root must be absolute.");
  const absolute = path ? resolveContainedPath(root, path, "Entry source path") : root;
  assertSafeMutationPath(root, absolute, "Entry source path");
  return absolute;
};

const resolveDirectory = async (spec: string): Promise<ResolvedCatalog> => {
  if (spec.startsWith("github:")) return resolveGithubDirectory(spec);
  const root = localRoot(spec);
  sourcePath(root, "");
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Source directory not found: ${root}`);
  }
  return { source: spec, root };
};

const entrySource = (source: ResolvedCatalog, path: string, digest: string): EntrySource => {
  sourcePath(source.root, path);
  if (source.source.startsWith("github:")) {
    const spec = parseGithubSource(source.source);
    const artifact = parseGithubSource(githubSource({
      ...spec, path: [spec.path, path].filter(Boolean).join("/"),
    }));
    if (!isCommitSha(source.resolved)) {
      throw new Error("GitHub entry source requires a resolved commit SHA.");
    }
    return { kind: "github", ...artifact, commit: source.resolved.toLowerCase(), digest };
  }
  if (!source.source.startsWith("local:")) {
    throw new Error(`Unsupported entry source: ${source.source}`);
  }
  return { kind: "local", root: source.root, path, digest };
};

const prepareSkill = (
  source: ResolvedCatalog,
  name: string,
  installedPath = `skills/${name}`,
): PreparedEntry => {
  if (!parseEntryId(`skill:${name}`)) throw new Error(`Invalid skill name "${name}".`);
  const skill = loadSkillDirectory(source.root, name, installedPath);
  return {
    id: `skill:${name}`,
    entry: skillToEntry(skill, entrySource(source, "", skill.digest)),
    catalog: {
      config: {}, configPath: resolve(source.root, "config.json"),
      skills: [skill], commands: [], mcp: [], plugins: [],
    },
  };
};

export const resolveCatalogId = (
  input: string,
  catalog: Catalog,
  references: SkillReference[],
): string => {
  const ids = [
    ...catalog.skills.map(({ name }) => `skill:${name}`),
    ...references.map(({ name }) => `skill:${name}`),
    ...catalog.commands.map(({ name }) => `command:${name}`),
    ...catalog.mcp.map(({ name }) => `mcp:${name}`),
    ...catalog.plugins.map(({ name }) => `plugin:${name}`),
  ];
  const matches = ids.filter((id) => input.includes(":") ? id === input : parseEntryId(id)?.name === input);
  if (!matches.length) throw new Error(`Unknown catalog entry "${input}".`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous catalog entry "${input}": ${matches.join(", ")}. Use a unique typed ID.`);
  }
  const id = matches[0]!;
  if (!parseEntryId(id)) throw new Error(`Invalid catalog entry ID "${id}".`);
  return id;
};

export const prepareCatalogEntry = async (
  source: ResolvedCatalog,
  catalog: Catalog,
  id: string,
  references: SkillReference[] = [],
  installedPath?: string,
): Promise<PreparedEntry> => {
  id = resolveCatalogId(id, catalog, references);
  const { type, name } = parseEntryId(id)!;
  const reference = type === "skill" ? references.find((item) => item.name === name) : undefined;
  if (reference) {
    return prepareSkill(await resolveGithubDirectory(reference.source), name, installedPath);
  }

  const prepared = structuredClone(catalog);
  if (type === "skill") {
    const skill = prepared.skills.find((item) => item.name === name)!;
    const provenance = entrySource(source, skill.sourcePath, skill.digest);
    skill.sourcePath = installedPath ?? `skills/${name}`;
    return { id, entry: skillToEntry(skill, provenance), catalog: prepared };
  }
  if (type === "command") {
    const command = prepared.commands.find((item) => item.name === name)!;
    const provenance = entrySource(source, command.sourcePath, command.digest);
    command.sourcePath = installedPath ?? `commands/${name}.md`;
    return { id, entry: commandToEntry(command, provenance), catalog: prepared };
  }
  if (type === "mcp") {
    const mcp = prepared.mcp.find((item) => item.name === name)!;
    return { id, entry: mcpToEntry(mcp, entrySource(source, "", mcp.configDigest)), catalog: prepared };
  }
  const plugin = prepared.plugins.find((item) => item.name === name)!;
  if (installedPath !== undefined && installedPath !== plugin.sourcePath) {
    throw new Error(`Unsupported plugin relocation for ${id}: installed at "${installedPath}", source requires "${plugin.sourcePath}".`);
  }
  return { id, entry: pluginToEntry(plugin, entrySource(source, "", plugin.digest)), catalog: prepared };
};

export const prepareDirectSkill = async (spec: string, name?: string): Promise<PreparedEntry> => {
  const github = spec.startsWith("github:") ? parseGithubSource(spec) : null;
  name ??= github ? posix.basename(github.path || github.repo) : basename(localRoot(spec));
  if (!parseEntryId(`skill:${name}`) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(`Invalid skill name "${name}".`);
  }
  return prepareSkill(await resolveDirectory(spec), name);
};

export const prepareEntryUpdate = async (
  id: string,
  entry: LockEntry,
  sourceOverride?: string,
): Promise<PreparedEntry> => {
  const parsed = parseEntryId(id);
  if (!parsed || parsed.type !== entry.type) throw new Error(`Invalid entry ID "${id}" for ${entry.type}.`);
  const current = entry.source;
  let spec = sourceOverride;
  if (spec === undefined) {
    if (current.kind === "legacy") {
      throw new Error(`Cannot update ${id}: legacy provenance is unverified. Use \`quiver-cli update ${id} --source=github:owner/repo[/path][#ref]\` (or local:/absolute/path) to explicitly select its source.`);
    }
    spec = current.kind === "github"
      ? githubSource(current)
      : `local:${sourcePath(current.root, current.path)}`;
  }

  let prepared: PreparedEntry;
  if (entry.type === "skill") {
    prepared = prepareSkill(await resolveDirectory(spec), parsed.name, entry.installedPath);
  } else if (entry.type === "command") {
    let source: ResolvedCatalog;
    let file: string;
    if (spec.startsWith("github:")) {
      const github = parseGithubSource(spec);
      if (!github.path) throw new Error(`Command source for ${id} must point to a file, not a repository root.`);
      file = posix.basename(github.path);
      const parent = posix.dirname(github.path);
      source = await resolveGithubDirectory(githubSource({ ...github, path: parent === "." ? "" : parent }));
    } else {
      const path = localRoot(spec);
      file = basename(path);
      source = { source: `local:${dirname(path)}`, root: dirname(path) };
    }
    const absPath = sourcePath(source.root, file);
    const stat = lstatSync(absPath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1) throw new Error(`Command source for ${id} must be a regular file: ${absPath}`);
    const command = { name: parsed.name, sourcePath: entry.installedPath, absPath, digest: fileDigest(absPath) };
    prepared = {
      id,
      entry: commandToEntry(command, entrySource(source, file, command.digest)),
      catalog: {
        config: {}, configPath: resolve(source.root, "config.json"),
        skills: [], commands: [command], mcp: [], plugins: [],
      },
    };
  } else {
    const source = await resolveDirectory(spec);
    prepared = await prepareCatalogEntry(
      source, loadCatalog(source), id, [], entry.type === "plugin" ? entry.installedPath : undefined,
    );
  }
  if (sourceOverride === undefined && current.kind === "local" && prepared.entry.source.kind === "local") {
    // Retain the declared local root/path, not just the leaf resolved for loading.
    prepared.entry.source = { ...current, digest: prepared.entry.source.digest };
  }
  return prepared;
};
