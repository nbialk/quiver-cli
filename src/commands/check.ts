import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import { parseEntryId, type McpEntry } from "../lockfile/schema.js";
import { diffSnapshots, isEmptyDiff, type ToolDiff } from "../mcp/diff.js";
import { introspect } from "../mcp/introspect.js";
import { toSnapshot } from "../mcp/snapshot.js";
import { interpolateEnvVars, loadEnvLocal } from "../secrets/interpolate.js";
import * as ui from "../ui/prompts.js";

interface SkillDriftItem {
  id: string;
  kind: "content";
}

interface McpReport {
  id: string;
  status: "ok" | "baseline" | "skipped" | "drift" | "accepted";
  reason?: string;
  diff?: ToolDiff;
}

export const check = async (options: CliOptions): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    return fail(options, "no-lockfile", "No quiver.lock found. Run `quiver-cli init` first.");
  }
  if (!repoCatalogExists(options.targetRoot)) {
    return fail(options, "no-agents", "No .agents/ directory found. Run `quiver-cli init` first.");
  }

  loadEnvLocal(options.targetRoot);
  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);

  // --- Skill / command content drift (local digests) -----------------------
  const skillByName = new Map(catalog.skills.map((s) => [s.name, s]));
  const commandByName = new Map(catalog.commands.map((c) => [c.name, c]));
  const skillDrift: SkillDriftItem[] = [];
  const checked = { skills: 0, commands: 0, mcp: 0 };

  for (const [id, entry] of Object.entries(lock.entries)) {
    const p = parseEntryId(id);
    if (!p) continue;
    if (entry.type === "skill") {
      const cat = skillByName.get(p.name);
      if (!cat) continue;
      checked.skills += 1;
      if (cat.digest !== entry.digest) skillDrift.push({ id, kind: "content" });
    } else if (entry.type === "command") {
      const cat = commandByName.get(p.name);
      if (!cat) continue;
      checked.commands += 1;
      if (cat.digest !== entry.digest) skillDrift.push({ id, kind: "content" });
    }
  }

  // --- MCP tool snapshot drift (re-introspection) --------------------------
  const mcpReports: McpReport[] = [];
  let lockChanged = false;

  for (const [id, entry] of Object.entries(lock.entries)) {
    if (entry.type !== "mcp") continue;
    const p = parseEntryId(id)!;
    const catMcp = catalog.mcp.find((m) => m.name === p.name);
    if (!catMcp) continue;
    checked.mcp += 1;

    const server = interpolateEnvVars(catMcp.server);
    const res = await introspect(server, { allowStdio: options.introspectStdio });
    if (!res.ok) {
      mcpReports.push({ id, status: "skipped", reason: res.reason });
      continue;
    }

    const current = toSnapshot(res.tools);
    const mcpEntry = entry as McpEntry;

    if (!mcpEntry.tools) {
      // First successful introspection: record baseline.
      mcpEntry.tools = current;
      mcpEntry.toolsFetchedAt = new Date().toISOString();
      lockChanged = true;
      mcpReports.push({ id, status: "baseline" });
      continue;
    }

    const diff = diffSnapshots(mcpEntry.tools, current);
    if (isEmptyDiff(diff)) {
      mcpReports.push({ id, status: "ok" });
    } else if (options.accept) {
      // Record the current snapshot as the new baseline.
      mcpEntry.tools = current;
      mcpEntry.toolsFetchedAt = new Date().toISOString();
      lockChanged = true;
      mcpReports.push({ id, status: "accepted", diff });
    } else {
      mcpReports.push({ id, status: "drift", diff });
    }
  }

  // Persist any newly recorded baselines.
  if (lockChanged) writeLockfile(options.targetRoot, lock);

  const hasDrift =
    skillDrift.length > 0 || mcpReports.some((r) => r.status === "drift");

  if (options.json) {
    console.log(
      JSON.stringify(
        { ok: !hasDrift, checked, skillDrift, mcp: mcpReports },
        null,
        2,
      ),
    );
    if (hasDrift) process.exitCode = 1;
    return;
  }

  await report(skillDrift, mcpReports, checked, options);
  if (hasDrift) process.exitCode = 1;
};

export interface CheckedCounts {
  skills: number;
  commands: number;
  mcp: number;
}

const report = async (
  skillDrift: SkillDriftItem[],
  mcpReports: McpReport[],
  checked: CheckedCounts,
  options: CliOptions,
): Promise<void> => {
  if (skillDrift.length) {
    await ui.warn(
      `Skill/command content changed since lockfile:\n  - ${skillDrift
        .map((s) => s.id)
        .join("\n  - ")}`,
    );
  }

  // Skipped servers (e.g. stdio without --introspect-stdio) are the common,
  // expected case - collapse them into a single line instead of one each.
  const skipped = mcpReports.filter((r) => r.status === "skipped");
  if (skipped.length) {
    const names = skipped.map((r) => parseEntryId(r.id)?.name ?? r.id);
    await ui.info(
      `skipped ${skipped.length} server${skipped.length === 1 ? "" : "s"}: ${names.join(", ")}` +
        (options.verbose
          ? "\n  - " +
            skipped.map((r) => `${r.id}: ${r.reason}`).join("\n  - ")
          : ""),
    );
  }

  const baselined = mcpReports.filter((r) => r.status === "baseline");
  if (baselined.length) {
    await ui.info(
      `recorded tool baseline: ${baselined.map((r) => r.id).join(", ")}`,
    );
  }

  const accepted = mcpReports.filter((r) => r.status === "accepted");
  for (const r of accepted) {
    await ui.success(`${r.id}: accepted new tool baseline`);
  }

  const drifted = mcpReports.filter((r) => r.status === "drift");
  for (const r of drifted) {
    if (!r.diff) continue;
    await ui.warn(`${r.id}: tool drift\n  - ${driftLines(r.diff, options.verbose).join("\n  - ")}`);
  }

  const summary = summarize(checked);
  const hasDrift = skillDrift.length > 0 || drifted.length > 0;
  if (!hasDrift) {
    await ui.success(`check passed: ${summary}, no drift detected.`);
  } else {
    await ui.info(`checked ${summary}, drift detected.`);
    await recommend(skillDrift, drifted);
  }
};

// Render the body of a tool-drift warning. Long lists are summarized with a
// count and a sample unless --verbose is given.
const driftLines = (diff: ToolDiff, verbose: boolean): string[] => {
  const lines: string[] = [];
  if (diff.added.length) lines.push(`new tools: ${list(diff.added, verbose)}`);
  if (diff.removed.length)
    lines.push(`removed tools: ${list(diff.removed, verbose)}`);
  if (diff.schemaChanged.length)
    lines.push(`schema changed: ${list(diff.schemaChanged, verbose)}`);

  if (diff.descriptionChanged.length) {
    const dc = diff.descriptionChanged;
    lines.push(
      `description changed (possible poisoning): ${list(dc.map((d) => d.name), verbose)}`,
    );
    if (verbose) {
      for (const d of dc) {
        lines.push(
          `  "${d.name}":\n` +
            `      before: ${truncate(d.before)}\n` +
            `      after:  ${truncate(d.after)}`,
        );
      }
    }
  }
  return lines;
};

// "213 tools (a, b, c, … +210 more)" - or the full sorted list when verbose.
const list = (names: string[], verbose: boolean, sample = 3): string => {
  if (verbose || names.length <= sample) {
    return `${names.length} ${names.length === 1 ? "tool" : "tools"} (${names.join(", ")})`;
  }
  const rest = names.length - sample;
  return `${names.length} tools (${names.slice(0, sample).join(", ")}, … +${rest} more)`;
};

// Tell the user how to update the lockfile for the drift that was found.
const recommend = async (
  skillDrift: SkillDriftItem[],
  drifted: McpReport[],
): Promise<void> => {
  const c = ui.palette();
  const lines: string[] = ["to update the lockfile baseline:"];
  if (drifted.length) {
    lines.push(`  ${c.cyan("quiver-cli check --accept")}   accept the new MCP tool snapshots`);
  }
  if (skillDrift.length) {
    const ids = skillDrift.map((s) => s.id);
    const one = ids.length === 1 ? ids[0] : "<id>";
    lines.push(
      `  ${c.cyan(`quiver-cli update ${one}`)}   pull catalog content for the changed skill/command`,
    );
    if (ids.length > 1) {
      lines.push(`  ${c.dim(`changed: ${ids.join(", ")}`)}`);
    }
  }
  ui.block(["", ...lines]);
};

// "4 skills, 1 command, 1 MCP server" - omits zero counts, pluralizes.
export const summarize = (c: CheckedCounts): string => {
  const plural = (n: number, word: string): string =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (c.skills) parts.push(plural(c.skills, "skill"));
  if (c.commands) parts.push(plural(c.commands, "command"));
  if (c.mcp) parts.push(plural(c.mcp, "MCP server"));
  return parts.length ? parts.join(", ") : "nothing";
};

const truncate = (s: string, max = 120): string =>
  s.length > max ? s.slice(0, max) + "…" : s;

const fail = async (
  options: CliOptions,
  code: string,
  message: string,
): Promise<void> => {
  if (options.json) console.log(JSON.stringify({ ok: false, error: code }));
  else await ui.error(message);
  process.exitCode = 1;
};
