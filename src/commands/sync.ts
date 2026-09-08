import type { CliOptions } from "../cli.js";
import { repoCatalogExists } from "../catalog/repo.js";
import { readLockfile } from "../lockfile/io.js";
import { formatWriteResult, writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";
import { ignoredSourcePaths } from "./gitignore.js";
import { inspectLocalEntries } from "./locksync.js";

export const sync = async (options: CliOptions): Promise<void> => {
  if (options.providers) {
    await ui.error(
      "sync does not change providers. Use `quiver-cli providers <a,b>` instead, then run `quiver-cli sync`.",
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
  if (!repoCatalogExists(options.targetRoot)) {
    await ui.error("No .agents/ directory found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }

  const { catalog, drift, missing, unsafe } = inspectLocalEntries(options.targetRoot, lock);
  if (missing.length) {
    await ui.warn(
      `Lockfile references missing local entries: ${missing.map((item) => item.id).join(", ")}. ` +
        `Run \`quiver-cli remove <id>\` to drop them.`,
    );
  }
  if (unsafe.length) {
    await ui.error(`Unsafe local entries:\n  - ${unsafe.map((item) => `${item.id}: ${item.reason}`).join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  if (drift.length) {
    await ui.warn(
      `Local drift detected:\n  - ${drift.map((item) => `${item.id}: ${item.kind} changed`).join("\n  - ")}\n` +
        "Baselines were not changed. Use `quiver-cli check <id> --accept` to accept local changes.",
    );
  }

  const ignored = ignoredSourcePaths(options.targetRoot);
  if (ignored.length) {
    await ui.warn(
      `Source of truth is gitignored: ${ignored.join(", ")}. ` +
        `Remove those .gitignore entries - a fresh clone would miss them.`,
    );
  }

  const result = writeProviders(options.targetRoot, catalog, lock);
  await ui.success(
    `Synced: ${result.generated.length} generated, ${result.linked.length} linked, ${result.removed.length} removed`,
  );
  const detail = formatWriteResult(options.targetRoot, result);
  if (detail.length) ui.block(detail);
};
