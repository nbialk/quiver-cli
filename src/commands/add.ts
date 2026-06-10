import type { CliOptions } from "../cli.js";
import { loadCatalog } from "../catalog/discover.js";
import {
  commandToEntry,
  mcpToEntry,
  skillToEntry,
} from "../catalog/entries.js";
import { materializeCatalog } from "../catalog/materialize.js";
import { loadRepoCatalog } from "../catalog/repo.js";
import { resolveCatalog } from "../catalog/resolve.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import { writeProviders } from "../providers/write.js";
import type { Selection } from "./select.js";
import * as ui from "../ui/prompts.js";

export const add = async (options: CliOptions): Promise<void> => {
  const id = options.positionals[0];
  if (!id) {
    await ui.error("Usage: quiver-cli add <skill:name|command:name|mcp:name>");
    process.exitCode = 1;
    return;
  }
  const parsed = parseEntryId(id);
  if (!parsed) {
    await ui.error(`Invalid id "${id}". Expected skill:<name>, command:<name> or mcp:<name>.`);
    process.exitCode = 1;
    return;
  }

  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    await ui.error("No quiver.lock found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }
  if (lock.entries[id]) {
    await ui.info(`${id} is already installed.`);
    return;
  }

  // New artifacts are sourced from the package catalog (the template).
  const source = resolveCatalog(lock.catalog.source);
  const sourceCatalog = loadCatalog(source);

  const skill = sourceCatalog.skills.find((s) => s.name === parsed.name);
  const command = sourceCatalog.commands.find((c) => c.name === parsed.name);
  const mcp = sourceCatalog.mcp.find((m) => m.name === parsed.name);

  const entry =
    parsed.type === "skill" && skill
      ? skillToEntry(skill)
      : parsed.type === "command" && command
        ? commandToEntry(command)
        : parsed.type === "mcp" && mcp
          ? mcpToEntry(mcp)
          : null;

  if (!entry) {
    await ui.error(`${id} not found in catalog.`);
    process.exitCode = 1;
    return;
  }

  // Materialize additively: keep everything already in the lockfile, plus the
  // new id.
  const selection = selectionFromLock(lock);
  if (parsed.type === "skill") selection.skills.push(parsed.name);
  if (parsed.type === "command") selection.commands.push(parsed.name);
  if (parsed.type === "mcp") selection.mcp.push(parsed.name);

  materializeCatalog(options.targetRoot, source, sourceCatalog, selection);

  lock.entries[id] = entry;
  writeLockfile(options.targetRoot, lock);

  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
  writeProviders(options.targetRoot, catalog, lock);
  await ui.success(`Added ${id}.`);
};

const selectionFromLock = (lock: NonNullable<ReturnType<typeof readLockfile>>): Selection => {
  const selection: Selection = { skills: [], commands: [], mcp: [] };
  for (const lid of Object.keys(lock.entries)) {
    const p = parseEntryId(lid);
    if (!p) continue;
    if (p.type === "skill") selection.skills.push(p.name);
    else if (p.type === "command") selection.commands.push(p.name);
    else if (p.type === "mcp") selection.mcp.push(p.name);
  }
  return selection;
};
