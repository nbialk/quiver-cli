import type { CliOptions } from "../cli.js";
import { loadCatalog } from "../catalog/discover.js";
import {
  commandToEntry,
  mcpToEntry,
  skillToEntry,
} from "../catalog/entries.js";
import { materializeCatalog } from "../catalog/materialize.js";
import { DEFAULT_CATALOG_SOURCE, resolveCatalog } from "../catalog/resolve.js";
import { emptyLockfile, lockfileExists, writeLockfile } from "../lockfile/io.js";
import { entryId, type Lockfile } from "../lockfile/schema.js";
import { resolveProviders } from "../providers/resolve.js";
import { writeProviders } from "../providers/write.js";
import { collectEnvVars } from "../secrets/interpolate.js";
import * as ui from "../ui/prompts.js";
import { ignoredSourcePaths, patchGitignore } from "./gitignore.js";
import { selectFromCatalog } from "./select.js";

export const init = async (options: CliOptions): Promise<void> => {
  await ui.banner();

  if (lockfileExists(options.targetRoot) && !options.force) {
    await ui.warn(
      "quiver.lock already exists. Use `quiver-cli add/remove` to change it, or --force to re-init.",
    );
    return;
  }

  const catalogSource = options.catalog ?? DEFAULT_CATALOG_SOURCE;
  const source = await resolveCatalog(catalogSource);
  if (source.resolved) {
    await ui.step(
      `Catalog: ${source.source} @ ${source.resolved.slice(0, 12)}${source.ref ? ` (${source.ref})` : ""}`,
    );
  }
  const sourceCatalog = loadCatalog(source);

  const selection = await selectFromCatalog(sourceCatalog, {
    interactive: !options.all,
  });

  const providers = await resolveProviders(options);
  if (providers === null) return; // invalid flag value, already reported

  // Materialize selected artifacts into the repo's .agents/, then re-discover
  // from there so digests and provider symlinks are repo-local.
  const resolved = materializeCatalog(
    options.targetRoot,
    source,
    sourceCatalog,
    selection,
  );
  const catalog = loadCatalog(resolved);

  const lock: Lockfile = emptyLockfile(resolved.source, {
    ref: source.ref ?? null,
    resolved: source.resolved ?? null,
  });
  lock.providers = providers;
  for (const skill of catalog.skills) {
    if (selection.skills.includes(skill.name)) {
      lock.entries[entryId("skill", skill.name)] = skillToEntry(skill);
    }
  }
  for (const command of catalog.commands) {
    if (selection.commands.includes(command.name)) {
      lock.entries[entryId("command", command.name)] = commandToEntry(command);
    }
  }
  for (const mcp of catalog.mcp) {
    if (selection.mcp.includes(mcp.name)) {
      lock.entries[entryId("mcp", mcp.name)] = mcpToEntry(mcp);
    }
  }

  writeLockfile(options.targetRoot, lock);
  await ui.step(
    `Wrote quiver.lock (${selection.skills.length} skills, ${selection.commands.length} commands, ${selection.mcp.length} MCP servers)`,
  );

  const result = writeProviders(options.targetRoot, catalog, lock);
  if (result.generated.length || result.linked.length) {
    await ui.step(
      `Provider configs: ${result.generated.length} generated, ${result.linked.length} linked`,
    );
  }

  if (patchGitignore(options.targetRoot, providers)) {
    await ui.step("Updated .gitignore (generated shims + .env.local ignored)");
  }

  const ignored = ignoredSourcePaths(options.targetRoot);
  if (ignored.length) {
    await ui.warn(
      `Source of truth is gitignored: ${ignored.join(", ")}. ` +
        `Remove those .gitignore entries - a fresh clone would miss them.`,
    );
  }

  const selectedServers = Object.fromEntries(
    catalog.mcp
      .filter((m) => selection.mcp.includes(m.name))
      .map((m) => [m.name, m.server]),
  );
  const envVars = collectEnvVars(selectedServers);
  if (envVars.length) {
    await ui.info(
      `MCP secrets needed: ${envVars.join(", ")} - fill them in .env.local (template: .env.local.example)`,
    );
  }

  await ui.outro(
    "Done. Commit .agents/ and quiver.lock; restart your AI tool to load the config.",
  );
};
