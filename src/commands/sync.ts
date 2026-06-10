import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import { writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";
import { ignoredSourcePaths } from "./gitignore.js";
import { refreshLockDigests } from "./locksync.js";

export const sync = async (options: CliOptions): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    await ui.error("No quiver.lock found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }
  if (!repoCatalogExists(options.targetRoot)) {
    await ui.error("No .agents/ directory found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }

  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);

  // Warn about lockfile entries whose source vanished from the repo catalog.
  const haveSkills = new Set(catalog.skills.map((s) => s.name));
  const haveCommands = new Set(catalog.commands.map((c) => c.name));
  const haveMcp = new Set(catalog.mcp.map((m) => m.name));
  const orphans: string[] = [];
  for (const id of Object.keys(lock.entries)) {
    const p = parseEntryId(id);
    if (!p) continue;
    const present =
      (p.type === "skill" && haveSkills.has(p.name)) ||
      (p.type === "command" && haveCommands.has(p.name)) ||
      (p.type === "mcp" && haveMcp.has(p.name));
    if (!present) orphans.push(id);
  }
  if (orphans.length) {
    await ui.warn(
      `Lockfile references missing catalog entries: ${orphans.join(", ")}. ` +
        `Run \`quiver-cli remove <id>\` to drop them.`,
    );
  }

  // Refresh digests/snapshots additively; report drift instead of silently
  // overwriting the lockfile's recorded state.
  const drift = refreshLockDigests(catalog, lock);
  if (drift.length) {
    await ui.warn(`Catalog drift detected:\n  - ${drift.join("\n  - ")}`);
  }

  const ignored = ignoredSourcePaths(options.targetRoot);
  if (ignored.length) {
    await ui.warn(
      `Source of truth is gitignored: ${ignored.join(", ")}. ` +
        `Remove those .gitignore entries - a fresh clone would miss them.`,
    );
  }

  writeLockfile(options.targetRoot, lock);
  const result = writeProviders(options.targetRoot, catalog, lock);
  await ui.success(
    `Synced: ${result.generated.length} generated, ${result.linked.length} linked, ${result.removed.length} removed`,
  );
};
