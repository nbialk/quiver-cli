import type { CliOptions } from "../cli.js";
import { jsonDigest } from "../catalog/digest.js";
import type { EntrySource, Lockfile } from "../lockfile/schema.js";
import { prepareEntryUpdate, type PreparedEntry } from "../sources/entry.js";
import { installedDigest } from "./install.js";

export type UpdateStatus = "updated" | "up-to-date" | "pinned" | "local-changes" | "legacy" | "error";
export interface UpdateReport {
  id: string;
  status: UpdateStatus;
  scope?: "adapter";
  reason?: string;
  from: EntrySource;
  to?: EntrySource;
  contentChanged?: boolean;
  /** Source content/identity changed relative to the pristine source baseline. */
  upstreamChanged?: boolean;
  /** Local or previously accepted customizations, independent of upstream. */
  localChanges?: boolean;
}

const sourceIdentity = (source: EntrySource): string => {
  if (source.kind === "legacy") return jsonDigest(source);
  const { digest: _digest, ...identity } = source;
  if ("commit" in identity) delete (identity as { commit?: string }).commit;
  return jsonDigest(identity);
};

const isPinned = (source: EntrySource): boolean => source.kind === "github" && /^[a-f0-9]{40}$/i.test(source.ref ?? "");

// Shared, project-read-only planning for update (including --dry-run) and check.
// Only update applies the returned prepared entries. Fetching may populate caches.
export const planUpdates = async (
  options: Pick<CliOptions, "targetRoot" | "source" | "force">, lock: Lockfile, ids: string[],
) => {
  const reports: UpdateReport[] = [];
  const pending: { prepared: PreparedEntry; digest: string; report: UpdateReport }[] = [];
  for (const id of ids) {
    const entry = lock.entries[id]!;
    const report: UpdateReport = {
      id, status: "up-to-date", from: entry.source,
      ...(entry.type === "plugin" ? { scope: "adapter" as const } : {}),
    };
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
      const sourceChanged = sourceIdentity(entry.source) !== sourceIdentity(candidate.source);
      report.localChanges = modified;
      report.upstreamChanged = pristine !== null && (digest !== pristine || sourceChanged);
      // An explicit source binding to identical bytes is metadata-only; it
      // neither discards local content nor claims a historical import event.
      if (modified && !options.force && !(options.source && local === digest)) {
        report.status = "local-changes";
        report.reason = "Local or accepted customizations preserved. Review before using --force.";
        continue;
      }
      if (local === digest && !sourceChanged && baseline === digest && pristine === digest) {
        report.status = isPinned(entry.source) ? "pinned" : "up-to-date";
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
  return { reports, pending };
};

export interface SourceUpdateReport {
  id: string;
  status: "up-to-date" | "update-available" | "pinned" | "legacy" | "skipped" | "error";
  scope?: "adapter";
  from: EntrySource;
  to?: EntrySource;
  localChanges?: boolean;
  blocked?: boolean;
  reason?: string;
}

export const checkSourceUpdates = async (
  options: Pick<CliOptions, "targetRoot" | "offline">, lock: Lockfile, ids: string[],
  progress?: { start: (id: string, completed: number, total: number) => void; complete: (result: SourceUpdateReport) => void },
): Promise<SourceUpdateReport[]> => {
  const results: SourceUpdateReport[] = [];
  for (const id of ids) {
    progress?.start(id, results.length, ids.length);
    const entry = lock.entries[id]!;
    const base = { id, from: entry.source, ...(entry.type === "plugin" ? { scope: "adapter" as const } : {}) };
    if (options.offline) {
      results.push({ ...base, status: "skipped", reason: "offline" });
    } else if (isPinned(entry.source)) {
      results.push({ ...base, status: "pinned", reason: "Fixed commit; not following newer source revisions." });
    } else if (entry.source.kind === "legacy") {
      results.push({ ...base, status: "legacy", reason: "Unverified V1 source. Select an explicit --source before checking for updates." });
    } else {
      const { reports: [report] } = await planUpdates({ targetRoot: options.targetRoot, force: false }, lock, [id]);
      results.push({
        ...base,
        status: report!.status === "error" ? "error" : report!.upstreamChanged ? "update-available" : "up-to-date",
        ...(report!.to ? { to: report!.to } : {}),
        ...(report!.localChanges !== undefined ? { localChanges: report!.localChanges } : {}),
        blocked: report!.status === "local-changes" && Boolean(report!.upstreamChanged),
        ...(report!.reason ? { reason: report!.reason } : {}),
      });
    }
    progress?.complete(results[results.length - 1]!);
  }
  return results;
};
