import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CliOptions } from "../cli.js";
import { removeArtifact } from "../catalog/materialize.js";
import { lockfilePath, readLockfile, requireV2Lockfile, writeLockfile } from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import { assertSafeMutationPath, resolveContainedPath } from "../path.js";
import { writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";
import { inspectLocalEntries } from "./locksync.js";

export const remove = async (options: CliOptions): Promise<void> => {
  const id = options.positionals[0];
  if (!id) {
    await ui.error(
      "Usage: quiver remove <skill:name|command:name|mcp:name|plugin:name>",
    );
    process.exitCode = 1;
    return;
  }
  const parsed = parseEntryId(id);
  if (!parsed) {
    await ui.error(`Invalid id "${id}".`);
    process.exitCode = 1;
    return;
  }

  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    await ui.error("No quiver.lock found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }
  requireV2Lockfile(lock);
  const entry = lock.entries[id];
  if (!entry) {
    await ui.info(`${id} is not installed.`);
    return;
  }

  const { catalog, unsafe } = inspectLocalEntries(options.targetRoot, lock);
  if (unsafe.length) {
    throw new Error(`Unsafe local content: ${unsafe.map((item) => `${item.id}: ${item.reason}`).join("; ")}`);
  }
  const current = entry.type === "mcp"
    ? catalog.mcp.find((item) => item.name === parsed.name)?.configDigest
    : [...catalog.skills, ...catalog.commands, ...catalog.plugins]
        .find((item) => item.name === parsed.name && item.sourcePath === entry.installedPath)?.digest;
  const accepted = entry.type === "mcp" ? entry.configDigest : entry.digest;
  const path = entry.type === "mcp" ? null : resolveContainedPath(
    resolve(options.targetRoot, ".agents"), entry.installedPath, id,
  );
  const dirty = current === undefined
    ? (path !== null && existsSync(path)) ||
      (entry.type === "plugin" && Object.hasOwn(catalog.config.plugins ?? {}, parsed.name))
    : current !== accepted || (entry.source.kind !== "legacy" && current !== entry.source.digest);
  if (dirty && !options.force) {
    await ui.error(`${id} has local changes. Use --force to remove it and discard those changes.`);
    process.exitCode = 1;
    return;
  }

  assertSafeMutationPath(options.targetRoot, lockfilePath(options.targetRoot), "Lockfile output");
  if (path) assertSafeMutationPath(options.targetRoot, path, "Artifact removal");
  if (entry.type === "skill") {
    assertSafeMutationPath(options.targetRoot, resolve(options.targetRoot, ".agents/skills"), "Skill group cleanup");
  }
  if (entry.type !== "mcp") {
    removeArtifact(options.targetRoot, entry.installedPath);
    if (entry.type === "skill") cleanupEmptyGroups(options.targetRoot);
  }

  // Remove only the selected definition; untracked local definitions are user content.
  if (entry.type === "mcp" || entry.type === "plugin") {
    const key = entry.type === "mcp" ? "mcpServers" : "plugins";
    const definitions = catalog.config[key];
    if (definitions && Object.hasOwn(definitions, parsed.name)) {
      delete definitions[parsed.name];
      if (!Object.keys(definitions).length) delete catalog.config[key];
      writeFileSync(catalog.configPath, JSON.stringify(catalog.config, null, 2) + "\n");
    }
  }

  delete lock.entries[id];
  writeLockfile(options.targetRoot, lock);
  writeProviders(options.targetRoot, catalog, lock);
  await ui.success(`Removed ${id}.`);
};

// Drop now-empty group folders under .agents/skills.
const cleanupEmptyGroups = (targetRoot: string): void => {
  const skillsRoot = resolve(targetRoot, ".agents/skills");
  if (!existsSync(skillsRoot)) return;
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(skillsRoot, entry.name);
    if (existsSync(resolve(dir, "SKILL.md"))) continue; // it's a skill
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
};
