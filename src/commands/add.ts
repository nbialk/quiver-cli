import type { CliOptions } from "../cli.js";
import { loadCatalog } from "../catalog/discover.js";
import {
  commandToEntry,
  mcpToEntry,
  pluginToEntry,
  skillToEntry,
} from "../catalog/entries.js";
import { materializeCatalogEntry } from "../catalog/materialize.js";
import { loadRepoCatalog } from "../catalog/repo.js";
import { resolveCatalog } from "../catalog/resolve.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import { writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";

export const add = async (options: CliOptions): Promise<void> => {
  const id = options.positionals[0];
  if (!id) {
    await ui.error(
      "Usage: quiver-cli add <skill:name|command:name|mcp:name|plugin:name>",
    );
    process.exitCode = 1;
    return;
  }
  const parsed = parseEntryId(id);
  if (!parsed) {
    await ui.error(
      `Invalid id "${id}". Expected skill:<name>, command:<name>, mcp:<name> or plugin:<name>.`,
    );
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

  // New artifacts are sourced from the locked catalog. Remote catalogs are
  // pinned to the lockfile's resolved SHA, so `add` is reproducible and a
  // cache hit needs no network. `update` moves the pin forward.
  const source = await resolveCatalog(lock.catalog.source, {
    pinnedSha: lock.catalog.resolved,
  });
  const sourceCatalog = loadCatalog(source);

  const skill = sourceCatalog.skills.find((s) => s.name === parsed.name);
  const command = sourceCatalog.commands.find((c) => c.name === parsed.name);
  const mcp = sourceCatalog.mcp.find((m) => m.name === parsed.name);
  const plugin = sourceCatalog.plugins.find((p) => p.name === parsed.name);

  const entry =
    parsed.type === "skill" && skill
      ? skillToEntry(skill)
      : parsed.type === "command" && command
        ? commandToEntry(command)
        : parsed.type === "mcp" && mcp
          ? mcpToEntry(mcp)
          : parsed.type === "plugin" && plugin
            ? pluginToEntry(plugin)
          : null;

  if (!entry) {
    await ui.error(`${id} not found in catalog.`);
    process.exitCode = 1;
    return;
  }
  if (
    entry.type === "plugin" &&
    lock.providers?.length &&
    !lock.providers.includes(entry.provider)
  ) {
    await ui.error(
      `${id} requires the ${entry.provider} provider. Enable it with ` +
        `\`quiver-cli providers ${entry.provider}\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  materializeCatalogEntry(
    options.targetRoot,
    sourceCatalog,
    parsed.type,
    parsed.name,
  );

  lock.entries[id] = entry;
  writeLockfile(options.targetRoot, lock);

  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
  writeProviders(options.targetRoot, catalog, lock);
  await ui.success(`Added ${id}.`);
};
