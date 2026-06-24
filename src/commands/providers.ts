import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import { PROVIDERS, type Provider } from "../lockfile/schema.js";
import {
  sameProviders,
  selectProviders,
  validateProviders,
} from "../providers/resolve.js";
import { formatWriteResult, writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";

// Change the active providers on an existing project. Accepts providers from a
// comma-separated positional arg or --providers= flag; falls back to an
// interactive multiselect pre-filled with the current selection. Regenerates
// configs and cleans up deselected providers' shims via writeProviders.
export const providers = async (options: CliOptions): Promise<void> => {
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

  const current = lock.providers?.length ? lock.providers : [...PROVIDERS];

  // Explicit list: comma-separated positional arg or --providers= flag.
  const explicit =
    options.providers ??
    (options.positionals[0]
      ? options.positionals[0]
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
      : null);

  let next: Provider[];
  if (explicit) {
    const { providers: valid, invalid } = validateProviders(explicit);
    if (invalid) {
      await ui.error(
        `Unknown provider(s): ${invalid.join(", ")}. Valid: ${PROVIDERS.join(", ")}.`,
      );
      process.exitCode = 1;
      return;
    }
    next = valid!;
  } else if (process.stdin.isTTY && !options.all) {
    next = await selectProviders(current);
  } else {
    await ui.error(
      `No providers given. Usage: quiver-cli providers <${PROVIDERS.join(",")}>`,
    );
    process.exitCode = 1;
    return;
  }

  if (!next.length) {
    await ui.error("At least one provider is required.");
    process.exitCode = 1;
    return;
  }

  if (sameProviders(next, current)) {
    await ui.info(`Providers already set to: ${current.join(", ")}.`);
    return;
  }

  lock.providers = next;
  writeLockfile(options.targetRoot, lock);

  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
  const result = writeProviders(options.targetRoot, catalog, lock);
  await ui.success(
    `Providers set to ${next.join(", ")}: ${result.generated.length} generated, ${result.linked.length} linked, ${result.removed.length} removed`,
  );
  const detail = formatWriteResult(options.targetRoot, result);
  if (detail.length) ui.block(detail);
};
