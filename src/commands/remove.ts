import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CliOptions } from "../cli.js";
import { removeArtifact } from "../catalog/materialize.js";
import { loadRepoCatalog } from "../catalog/repo.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import { writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";

export const remove = async (options: CliOptions): Promise<void> => {
  const id = options.positionals[0];
  if (!id) {
    await ui.error("Usage: quiver remove <skill:name|command:name|mcp:name>");
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
  const entry = lock.entries[id];
  if (!entry) {
    await ui.info(`${id} is not installed.`);
    return;
  }

  // Remove the materialized artifact (skills/commands). MCP entries only live
  // in config.json, which is rewritten by writeProviders below.
  if (entry.type === "skill" || entry.type === "command") {
    removeArtifact(options.targetRoot, entry.sourcePath);
    cleanupEmptyGroups(options.targetRoot);
  }

  delete lock.entries[id];
  writeLockfile(options.targetRoot, lock);

  // For MCP removal we must also rewrite the materialized config.json so the
  // repo catalog no longer advertises the server.
  rewriteRepoMcp(options.targetRoot, lock);

  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
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

// Rewrite .agents/config.json mcpServers to match remaining lockfile mcp entries.
const rewriteRepoMcp = (
  targetRoot: string,
  lock: NonNullable<ReturnType<typeof readLockfile>>,
): void => {
  const configPath = resolve(targetRoot, ".agents/config.json");
  if (!existsSync(configPath)) return;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  if (!config.mcpServers) return;
  const keep = new Set(
    Object.keys(lock.entries)
      .map(parseEntryId)
      .filter((p): p is { type: "mcp"; name: string } => p?.type === "mcp")
      .map((p) => p.name),
  );
  const kept: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (keep.has(name)) kept[name] = server;
  }
  if (Object.keys(kept).length) config.mcpServers = kept;
  else delete config.mcpServers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
};
