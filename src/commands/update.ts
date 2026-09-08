import type { CliOptions } from "../cli.js";
import { resolveInstalledId } from "../cli.js";
import { jsonDigest } from "../catalog/digest.js";
import { repoCatalogExists } from "../catalog/repo.js";
import { readLockfile, requireV2Lockfile } from "../lockfile/io.js";
import type { EntrySource } from "../lockfile/schema.js";
import { writeProviders } from "../providers/write.js";
import { prepareEntryUpdate, type PreparedEntry } from "../sources/entry.js";
import * as ui from "../ui/prompts.js";
import { installedDigest, installPreparedEntry } from "./install.js";
import { inspectLocalEntries } from "./locksync.js";

type UpdateStatus = "updated" | "up-to-date" | "pinned" | "local-changes" | "legacy" | "error";
interface UpdateReport {
  id: string;
  status: UpdateStatus;
  reason?: string;
  from: EntrySource;
  to?: EntrySource;
  contentChanged?: boolean;
}

const sourceIdentity = (source: EntrySource): string => {
  if (source.kind === "legacy") return jsonDigest(source);
  const { digest: _digest, ...identity } = source;
  if ("commit" in identity) delete (identity as { commit?: string }).commit;
  return jsonDigest(identity);
};

export const update = async (options: CliOptions): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) throw new Error("No quiver.lock found. Run `quiver-cli init` first.");
  requireV2Lockfile(lock);
  if (!repoCatalogExists(options.targetRoot)) throw new Error("No .agents/ directory found.");
  if (options.positionals.length > 1 || (options.source && !options.positionals.length)) {
    throw new Error("Usage: quiver-cli update [id] [--source=github:owner/repo/path].");
  }
  const ids = options.positionals[0]
    ? [resolveInstalledId(options.positionals[0], lock)] : Object.keys(lock.entries).sort();
  const reports: UpdateReport[] = [];
  const pending: { prepared: PreparedEntry; digest: string; report: UpdateReport }[] = [];

  for (const id of ids) {
    const entry = lock.entries[id]!;
    const report: UpdateReport = { id, status: "up-to-date", from: entry.source };
    reports.push(report);
    try {
      const local = installedDigest(options.targetRoot, id, entry, lock);
      if (entry.source.kind === "legacy" && !options.source) {
        report.status = "legacy";
        report.reason = "Unverified V1 source. Select an explicit --source before updating.";
        continue;
      }
      const prepared = await prepareEntryUpdate(id, entry, options.source ?? undefined);
      const candidate = prepared.entry;
      const digest = candidate.type === "mcp" ? candidate.configDigest : candidate.digest;
      report.to = candidate.source;
      report.contentChanged = local !== digest;
      const baseline = entry.type === "mcp" ? entry.configDigest : entry.digest;
      const pristine = entry.source.kind === "legacy" ? null : entry.source.digest;
      const modified = local !== baseline || pristine === null || local !== pristine;
      // An explicit source binding to identical bytes is metadata-only; it
      // neither discards local content nor claims a historical import event.
      if (modified && !options.force && !(options.source && local === digest)) {
        report.status = "local-changes";
        report.reason = "Local or accepted customizations preserved. Review before using --force.";
        continue;
      }
      const sourceChanged = sourceIdentity(entry.source) !== sourceIdentity(candidate.source);
      if (local === digest && !sourceChanged && baseline === digest && pristine === digest) {
        report.status = entry.source.kind === "github" && /^[a-f0-9]{40}$/i.test(entry.source.ref ?? "")
          ? "pinned" : "up-to-date";
        // A repository-only commit change is not an artifact update.
        delete report.to;
        continue;
      }
      if (candidate.type === "mcp" && entry.type === "mcp" && entry.configDigest === digest) {
        candidate.tools = entry.tools;
        candidate.toolsFetchedAt = entry.toolsFetchedAt;
        if (entry.authRequired !== undefined) candidate.authRequired = entry.authRequired;
      }
      report.status = "updated";
      pending.push({ prepared, digest: local, report });
    } catch (error) {
      report.status = "error";
      report.reason = error instanceof Error ? error.message : String(error);
    }
  }

  let contentApplied = false;
  if (!options.dryRun) {
    for (const item of pending) {
      try {
        installPreparedEntry(options.targetRoot, lock, item.prepared, item.digest);
        if (item.report.contentChanged) contentApplied = true;
      } catch (error) {
        item.report.status = "error";
        item.report.reason = error instanceof Error ? error.message : String(error);
      }
    }
  }
  let providerError: string | undefined;
  if (contentApplied) {
    try {
      writeProviders(options.targetRoot, inspectLocalEntries(options.targetRoot, lock).catalog, lock);
    } catch (error) {
      providerError = `${error instanceof Error ? error.message : String(error)}. Installed entries are locked; retry quiver-cli sync.`;
    }
  }
  const by = (status: UpdateStatus): string[] => reports.filter((item) => item.status === status).map((item) => item.id);
  const errors = by("error");
  const blocked = [...by("local-changes"), ...by("legacy")];
  const ok = !errors.length && !blocked.length && !providerError;
  if (options.json) {
    console.log(JSON.stringify({
      ok, dryRun: options.dryRun, updated: by("updated"), upToDate: by("up-to-date"),
      pinned: by("pinned"), localChanges: by("local-changes"), legacy: by("legacy"),
      errors, reports, ...(providerError ? { providerError } : {}),
    }, null, 2));
  } else {
    ui.block(reports.map((item) => `${item.id}: ${item.status === "updated" && options.dryRun ? "update available" : item.status}${item.reason ? ` (${item.reason})` : ""}`));
    if (providerError) await ui.error(providerError);
    if (!reports.length) await ui.info("No installed entries to update.");
  }
  if (!ok) process.exitCode = errors.length || providerError ? 2 : 1;
};
