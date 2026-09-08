import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { jsonDigest } from "../catalog/digest.js";
import { materializeCatalogEntry } from "../catalog/materialize.js";
import { readLockfile, requireV2Lockfile, writeLockfile } from "../lockfile/io.js";
import { parseEntryId, PROVIDERS, type LockEntry, type Lockfile } from "../lockfile/schema.js";
import { assertSafeMutationPath, resolveContainedPath } from "../path.js";
import type { PreparedEntry } from "../sources/entry.js";
import { inspectLocalEntries } from "./locksync.js";

export const installedDigest = (
  targetRoot: string,
  id: string,
  entry: LockEntry,
  lock: Lockfile,
): string => {
  const local = inspectLocalEntries(targetRoot, { ...lock, entries: { [id]: entry } });
  const issue = [...local.missing, ...local.unsafe][0];
  if (issue) throw new Error(`${id}: ${issue.reason}`);
  const { name } = parseEntryId(id)!;
  if (entry.type === "mcp") {
    return local.catalog.mcp.find((item) => item.name === name)!.configDigest;
  }
  const items = entry.type === "skill" ? local.catalog.skills
    : entry.type === "command" ? local.catalog.commands : local.catalog.plugins;
  return items.find((item) => item.name === name)!.digest;
};

// Check identities without loading unrelated skill content or broken plugins.
export const validateAdditions = (
  targetRoot: string,
  lock: Lockfile,
  prepared: PreparedEntry[],
): void => {
  const root = resolve(targetRoot, ".agents");
  const { config } = inspectLocalEntries(targetRoot, { ...lock, entries: {} }).catalog;
  const occupied = new Map(Object.keys(lock.entries).map((id) => [id.toLowerCase(), id]));
  for (const [type, definitions] of [
    ["mcp", config.mcpServers], ["plugin", config.plugins],
  ] as const) {
    for (const name of Object.keys(definitions ?? {})) {
      occupied.set(`${type}:${name}`.toLowerCase(), `${type}:${name}`);
    }
  }
  if (prepared.some(({ entry }) => entry.type === "skill")) {
    const pending = [resolve(root, "skills")];
    while (pending.length) {
      const dir = pending.pop()!;
      assertSafeMutationPath(targetRoot, dir, "Local skills");
      if (!lstatSync(dir, { throwIfNoEntry: false })) continue;
      for (const child of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, child.name);
        if (child.isSymbolicLink() ||
          (child.isDirectory() && lstatSync(resolve(path, "SKILL.md"), { throwIfNoEntry: false }))) {
          occupied.set(`skill:${child.name}`.toLowerCase(), `skill:${child.name}`);
        } else if (child.isDirectory()) {
          pending.push(path);
        }
      }
    }
  }
  if (prepared.some(({ entry }) => entry.type === "command")) {
    const dir = resolve(root, "commands");
    assertSafeMutationPath(targetRoot, dir, "Local commands");
    if (lstatSync(dir, { throwIfNoEntry: false })) {
      for (const name of readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".md"))) {
        const id = `command:${name.slice(0, -3)}`;
        occupied.set(id.toLowerCase(), id);
      }
    }
  }
  const paths = ["config.json", "config.local.json", "AGENTS.md", "CLAUDE.md"]
    .map((path) => resolve(root, path).toLowerCase());
  for (const [id, entry] of Object.entries(lock.entries)) {
    if (entry.type !== "mcp") paths.push(resolveContainedPath(root, entry.installedPath, id).toLowerCase());
  }
  const providers = lock.providers?.length ? lock.providers : [...PROVIDERS];
  for (const { id, entry } of prepared) {
    if (parseEntryId(id)?.type !== entry.type) throw new Error(`Invalid prepared entry: ${id}.`);
    const conflict = occupied.get(id.toLowerCase());
    if (conflict) {
      throw new Error(`${id} conflicts with existing ${conflict} (names are case-insensitive). Keep local content; use a different --name for a direct skill or update an installed entry with \`quiver-cli update ${conflict} --source=github:owner/repo[/path][#ref]\`.`);
    }
    occupied.set(id.toLowerCase(), id);
    if (entry.type === "plugin" && entry.provider !== "opencode") {
      throw new Error(`${id} has an unsupported plugin provider: ${entry.provider}. Only opencode plugins are supported.`);
    }
    if (entry.type === "plugin" && !providers.includes(entry.provider)) {
      throw new Error(`${id} requires the ${entry.provider} provider. Enable it with \`quiver-cli providers ${entry.provider}\` first.`);
    }
    if (entry.type === "mcp") continue;
    const path = resolveContainedPath(root, entry.installedPath, id);
    assertSafeMutationPath(targetRoot, path, id);
    const normalized = path.toLowerCase();
    if (paths.some((other) => normalized === other || normalized.startsWith(`${other}${sep}`) || other.startsWith(`${normalized}${sep}`))) {
      throw new Error(`${id} has a conflicting installed path: ${entry.installedPath}. Choose a different entry or alias.`);
    }
    if (lstatSync(path, { throwIfNoEntry: false })) {
      throw new Error(`Cannot add ${id}: ${entry.installedPath} already exists. Move local content or choose a different --name; add never overwrites it.`);
    }
    paths.push(normalized);
  }
};

// Commit each artifact together with its lock entry. Provider files are derived
// afterwards, so a later entry or provider failure cannot lose an earlier pin.
export const installPreparedEntry = (
  targetRoot: string,
  lock: Lockfile,
  prepared: PreparedEntry,
  expectedDigest?: string,
): void => {
  requireV2Lockfile(lock);
  const { id, entry, catalog } = prepared;
  const parsed = parseEntryId(id);
  if (!parsed || parsed.type !== entry.type) throw new Error("Invalid prepared entry identity.");
  const previous = lock.entries[id];
  if (expectedDigest === undefined && previous) throw new Error(`${id} is already installed.`);
  if (expectedDigest !== undefined && !previous) throw new Error(`${id} is no longer installed.`);
  if (!previous) validateAdditions(targetRoot, lock, [prepared]);

  const root = resolve(targetRoot, ".agents");
  const artifact = entry.type === "mcp" ? null
    : resolveContainedPath(root, entry.installedPath, `${id} installed path`);
  const configPath = resolve(root, "config.json");
  assertSafeMutationPath(targetRoot, configPath, "Installed config");
  if (artifact) {
    assertSafeMutationPath(targetRoot, artifact, "Installed artifact");
    if ([configPath, resolve(root, "AGENTS.md"), resolve(root, "README.md")].includes(artifact)) {
      throw new Error(`${id} overlaps shared agent configuration.`);
    }
    for (const [otherId, other] of Object.entries(lock.entries)) {
      if (otherId === id || other.type === "mcp") continue;
      const otherPath = resolveContainedPath(root, other.installedPath, otherId).toLowerCase();
      const path = artifact.toLowerCase();
      if (path === otherPath || path.startsWith(`${otherPath}${sep}`) || otherPath.startsWith(`${path}${sep}`)) {
        throw new Error(`${id} overlaps installed entry ${otherId}.`);
      }
    }
  }
  if (Object.keys(lock.entries).some((other) => other !== id && other.toLowerCase() === id.toLowerCase())) {
    throw new Error(`Installed name collision: ${id}.`);
  }

  const configBefore = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;

  const checkUnchanged = (): void => {
    const current = readLockfile(targetRoot);
    if (!current || jsonDigest(current) !== jsonDigest(lock)) {
      throw new Error("quiver.lock changed during the operation; retry after reviewing the changes.");
    }
    if ((existsSync(configPath) ? readFileSync(configPath, "utf8") : null) !== configBefore) {
      throw new Error(".agents/config.json changed during the operation; retry after reviewing the changes.");
    }
    if (previous && installedDigest(targetRoot, id, previous, lock) !== expectedDigest) {
      throw new Error(`${id} changed during the operation; no update was applied.`);
    }
    if (!previous && artifact && lstatSync(artifact, { throwIfNoEntry: false })) {
      throw new Error(`${id} appeared during the operation; no files were overwritten.`);
    }
    if (!previous) validateAdditions(targetRoot, lock, [prepared]);
  };
  checkUnchanged();

  const expected = entry.type === "mcp" ? entry.configDigest : entry.digest;
  if (previous && expectedDigest === expected) {
    lock.entries[id] = entry;
    try {
      writeLockfile(targetRoot, lock);
    } catch (error) {
      lock.entries[id] = previous;
      throw error;
    }
    return;
  }

  const stage = mkdtempSync(resolve(targetRoot, ".quiver-stage-"));
  const changes: { dest: string; backup: string; hadOriginal: boolean; replaced: boolean }[] = [];
  let retainBackup = false;
  try {
    const stagedRoot = resolve(stage, ".agents");
    mkdirSync(stagedRoot);
    writeFileSync(resolve(stagedRoot, "config.json"), configBefore ?? "{}\n");
    materializeCatalogEntry(stage, catalog, parsed.type, parsed.name);
    if (installedDigest(stage, id, entry, lock) !== expected) {
      throw new Error(`${id} source changed while being staged; nothing was installed.`);
    }

    const paths = [
      ...(artifact ? [{ dest: artifact, staged: resolveContainedPath(stagedRoot, entry.type === "mcp" ? "" : entry.installedPath, id) }] : []),
      ...(["mcp", "plugin"].includes(entry.type) ? [{ dest: configPath, staged: resolve(stagedRoot, "config.json") }] : []),
    ];
    const example = resolve(targetRoot, ".env.local.example");
    const stagedExample = resolve(stage, ".env.local.example");
    if (!existsSync(example) && existsSync(stagedExample)) paths.push({ dest: example, staged: stagedExample });
    for (const { dest } of paths) assertSafeMutationPath(targetRoot, dest, "Entry output");
    checkUnchanged();

    for (const [index, { dest, staged }] of paths.entries()) {
      mkdirSync(dirname(dest), { recursive: true });
      assertSafeMutationPath(targetRoot, dest, "Entry output");
      if (dest === example && lstatSync(dest, { throwIfNoEntry: false })) continue;
      if (!previous && dest === artifact && lstatSync(dest, { throwIfNoEntry: false })) {
        throw new Error(`${id} appeared during the operation; no files were overwritten.`);
      }
      const change = { dest, backup: resolve(stage, `backup-${index}`), hadOriginal: false, replaced: false };
      changes.push(change);
      if (lstatSync(dest, { throwIfNoEntry: false })) {
        renameSync(dest, change.backup);
        change.hadOriginal = true;
      }
      renameSync(staged, dest);
      change.replaced = true;
    }
    lock.entries[id] = entry;
    writeLockfile(targetRoot, lock);
  } catch (error) {
    if (previous) lock.entries[id] = previous;
    else delete lock.entries[id];
    try {
      for (const change of changes.reverse()) {
        assertSafeMutationPath(targetRoot, change.dest, "Entry rollback");
        if (change.replaced) rmSync(change.dest, { recursive: true, force: true });
        if (change.hadOriginal) renameSync(change.backup, change.dest);
      }
    } catch (rollbackError) {
      retainBackup = true;
      throw new AggregateError([error, rollbackError], `Could not restore ${id}. Recovery files were retained at ${stage}.`);
    }
    throw error;
  } finally {
    if (!retainBackup) rmSync(stage, { recursive: true, force: true });
  }
};
