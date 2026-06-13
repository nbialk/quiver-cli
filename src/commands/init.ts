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
import {
  entryId,
  isProvider,
  PROVIDERS,
  type Lockfile,
  type Provider,
} from "../lockfile/schema.js";
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

  const envVars = collectEnvVars(catalog.config.mcpServers ?? {});
  if (envVars.length) {
    await ui.info(
      `MCP secrets needed: ${envVars.join(", ")} - fill them in .env.local (template: .env.local.example)`,
    );
  }

  await ui.outro(
    "Done. Commit .agents/ and quiver.lock; restart your AI tool to load the config.",
  );
};

// Resolve target providers: --providers= flag wins, then an interactive
// multiselect (default: all), falling back to all when non-interactive.
// Returns null when the flag contains invalid values (error already shown).
const resolveProviders = async (
  options: CliOptions,
): Promise<Provider[] | null> => {
  if (options.providers) {
    const invalid = options.providers.filter((p) => !isProvider(p));
    if (invalid.length) {
      await ui.error(
        `Unknown provider(s): ${invalid.join(", ")}. Valid: ${PROVIDERS.join(", ")}.`,
      );
      process.exitCode = 1;
      return null;
    }
    return options.providers.filter(isProvider);
  }

  if (options.all || !process.stdin.isTTY) return [...PROVIDERS];

  const picked = await ui.selectGrouped<Provider>({
    message: "Generate configs for (space toggles, enter confirms)",
    groups: [
      {
        name: "providers",
        items: [
          { value: "claude", label: "Claude Code" },
          { value: "opencode", label: "opencode" },
          { value: "codex", label: "Codex" },
        ],
      },
    ],
    initialValues: [...PROVIDERS],
  });
  return picked.length ? picked : [...PROVIDERS];
};
