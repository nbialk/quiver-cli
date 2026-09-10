import type { CliOptions } from "../cli.js";
import { resolveInstalledId } from "../cli.js";
import { repoCatalogExists } from "../catalog/repo.js";
import { readLockfile, requireV2Lockfile } from "../lockfile/io.js";
import { writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";
import { installPreparedEntry } from "./install.js";
import { inspectLocalEntries } from "./locksync.js";
import { planUpdates, type UpdateReport, type UpdateStatus } from "./update-plan.js";

const printReports = (reports: UpdateReport[], dryRun: boolean, providerError?: string): void => {
  const color = ui.palette();
  const labels: Record<UpdateStatus, string> = {
    updated: dryRun ? "Update available" : "Updated",
    "up-to-date": "Up to date",
    pinned: "Pinned",
    "local-changes": "Local changes preserved",
    legacy: "Legacy source",
    error: "Failed",
  };
  const marker = (status: UpdateStatus): string => status === "error"
    ? color.red("✖") : status === "legacy" || status === "local-changes"
      ? color.yellow("⚠") : color.green("✔");
  const width = reports.reduce((max, item) => Math.max(max, item.id.length), 0);
  const reasons = new Map<string, UpdateReport[]>();
  for (const item of reports) {
    if (item.reason) {
      const group = reasons.get(item.reason) ?? [];
      group.push(item);
      reasons.set(item.reason, group);
    }
  }
  const detail = (reason: string): string => reason.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
  const lines: string[] = [];
  for (const item of reports) {
    lines.push(`  ${marker(item.status)} ${item.id.padEnd(width)}   ${item.scope === "adapter" ? "Adapter: " : ""}${labels[item.status]}`);
    if (item.reason && reasons.get(item.reason)!.length === 1) lines.push(detail(item.reason));
  }
  for (const [reason, items] of reasons) {
    if (items.length > 1) {
      lines.push("", `  ${marker(items[0]!.status)} ${items.map((item) => item.id).join(", ")}`, detail(reason));
    }
  }
  if (providerError) lines.push("", `  ${color.red("✖")} Provider sync failed`, detail(providerError));
  if (!reports.length) lines.push("  No installed entries to update.");
  if (reports.some((item) => item.scope === "adapter")) {
    lines.push("", "  Plugin statuses cover adapter sources. Check external binaries with `quiver-cli check`.");
  }

  const count = (status: UpdateStatus): number => reports.filter((item) => item.status === status).length;
  const summary = [
    `${count("updated")} ${dryRun ? `update${count("updated") === 1 ? "" : "s"} available` : "updated"}`,
    `${count("up-to-date")} up to date`,
    ...(count("pinned") ? [`${count("pinned")} pinned`] : []),
    `${count("legacy") + count("local-changes")} needs attention`,
    `${count("error")} failed`,
    ...(providerError ? ["provider sync failed"] : []),
  ];
  lines.push("", `${dryRun ? "Dry run" : "Done"}: ${summary.join(" · ")}`);
  ui.block(lines);
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
  if (!options.json) ui.block([options.dryRun ? "Checking for updates (dry run)…" : "Updating installed components…", ""]);
  const { reports, pending } = await planUpdates(options, lock, ids);

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
    printReports(reports, options.dryRun, providerError);
  }
  if (!ok) process.exitCode = errors.length || providerError ? 2 : 1;
};
