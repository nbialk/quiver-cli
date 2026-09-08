import type { CliOptions } from "../cli.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import { LOCKFILE_VERSION, type LockfileVersion } from "../lockfile/schema.js";
import * as ui from "../ui/prompts.js";

export const migrate = async (options: CliOptions): Promise<void> => {
  let fromVersion: LockfileVersion | null = null;
  try {
    if (options.positionals.length) {
      throw new Error(
        "Usage: quiver-cli migrate [--dry-run] [--json]. This command takes no positional arguments.",
      );
    }
    const lock = readLockfile(options.targetRoot);
    if (!lock) throw new Error("No quiver.lock found. Run `quiver-cli init` first.");
    fromVersion = lock.version;
    const entries = Object.keys(lock.entries).sort().map((id) => ({
      id,
      source: lock.entries[id]!.source,
      unverified: lock.entries[id]!.source.kind === "legacy",
    }));

    if (fromVersion !== LOCKFILE_VERSION && !options.dryRun) {
      writeLockfile(options.targetRoot, { ...lock, version: LOCKFILE_VERSION });
    }
    if (options.json) {
      console.log(JSON.stringify(
        {
          ok: true,
          fromVersion,
          toVersion: LOCKFILE_VERSION,
          dryRun: options.dryRun,
          entries,
        },
        null,
        2,
      ));
      return;
    }
    if (fromVersion === LOCKFILE_VERSION) {
      await ui.info(
        `quiver.lock is already version ${LOCKFILE_VERSION}; no changes made.`,
      );
      return;
    }
    const summary = `${options.dryRun ? "Would migrate" : "Migrated"} quiver.lock from version ${fromVersion} to ${LOCKFILE_VERSION} (${entries.length} entries).`;
    if (options.dryRun) await ui.info(`${summary} No files changed.`);
    else await ui.success(summary);
    for (const { id, source } of entries) {
      if (source.kind !== "legacy") continue;
      await ui.warn(
        `${id}: unverified origin ${source.catalog.source}` +
          (source.sourcePath !== undefined ? `, path ${source.sourcePath}` : "") +
          (source.pin != null ? `, old pin ${JSON.stringify(source.pin)}` : "") +
          ".",
      );
    }
    await ui.info(
      "Local baselines, files, and MCP snapshots are unchanged. Legacy origins remain unverified; no source content was fetched.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify(
        {
          ok: false,
          fromVersion,
          toVersion: LOCKFILE_VERSION,
          dryRun: options.dryRun,
          entries: [],
          error: message,
        },
        null,
        2,
      ));
    } else {
      await ui.error(message);
    }
    process.exitCode = 1;
  }
};
