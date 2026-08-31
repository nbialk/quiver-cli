import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile } from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import {
  disabledMcpServers,
  setMcpEnabled,
} from "../providers/local-config.js";
import { writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";
import { ensureLocalOverrideIgnored } from "./gitignore.js";

// enable/disable flip a server's local state in .agents/config.local.json
// (gitignored) and regenerate the provider configs. The server stays in
// .agents/config.json and quiver.lock, so re-enabling is instant.
export const toggle = async (
  options: CliOptions,
  enabled: boolean,
): Promise<void> => {
  const verb = enabled ? "enable" : "disable";
  const id = options.positionals[0];
  const parsed = id ? parseEntryId(id) : null;
  if (!parsed || parsed.type !== "mcp") {
    await ui.error(`Usage: quiver-cli ${verb} mcp:<name>`);
    process.exitCode = 1;
    return;
  }

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

  if (!lock.entries[id!]) {
    const installed = Object.keys(lock.entries)
      .map(parseEntryId)
      .filter((p) => p?.type === "mcp")
      .map((p) => p!.name)
      .sort((a, b) => a.localeCompare(b));
    await ui.error(
      `${id} is not installed.` +
        (installed.length
          ? ` Installed MCP servers: ${installed.join(", ")}.`
          : " No MCP servers installed."),
    );
    process.exitCode = 1;
    return;
  }

  const disabled = disabledMcpServers(options.targetRoot);
  if (enabled !== disabled.has(parsed.name)) {
    await ui.info(`${id} is already ${enabled ? "enabled" : "disabled"}.`);
    return;
  }

  setMcpEnabled(options.targetRoot, parsed.name, enabled);
  if (!enabled && ensureLocalOverrideIgnored(options.targetRoot)) {
    await ui.step("Added .agents/config.local.json to .gitignore");
  }
  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
  writeProviders(options.targetRoot, catalog, lock);
  await ui.success(
    enabled
      ? `Enabled ${id}.`
      : `Disabled ${id} locally (.agents/config.local.json). Re-enable with \`quiver-cli enable ${id}\`.`,
  );
};
