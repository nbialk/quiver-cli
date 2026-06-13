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
  status: "ok" | "baseline" | "skipped" | "drift";
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

  await report(skillDrift, mcpReports, checked);
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
): Promise<void> => {
  if (skillDrift.length) {
    await ui.warn(
      `Skill/command content changed since lockfile:\n  - ${skillDrift
        .map((s) => s.id)
        .join("\n  - ")}`,
    );
  }

  for (const r of mcpReports) {
    if (r.status === "ok") {
      await ui.success(`${r.id}: no tool changes`);
    } else if (r.status === "baseline") {
      await ui.info(`${r.id}: recorded tool baseline`);
    } else if (r.status === "skipped") {
      await ui.info(`${r.id}: skipped (${r.reason})`);
    } else if (r.status === "drift" && r.diff) {
      const lines: string[] = [];
      if (r.diff.added.length) lines.push(`new tools: ${r.diff.added.join(", ")}`);
      if (r.diff.removed.length)
        lines.push(`removed tools: ${r.diff.removed.join(", ")}`);
      if (r.diff.schemaChanged.length)
        lines.push(`schema changed: ${r.diff.schemaChanged.join(", ")}`);
      for (const dc of r.diff.descriptionChanged) {
        lines.push(
          `DESCRIPTION CHANGED (possible poisoning) "${dc.name}":\n` +
            `      before: ${truncate(dc.before)}\n` +
            `      after:  ${truncate(dc.after)}`,
        );
      }
      await ui.warn(`${r.id}: tool drift\n  - ${lines.join("\n  - ")}`);
    }
  }

  const summary = summarize(checked);
  if (!skillDrift.length && !mcpReports.some((r) => r.status === "drift")) {
    await ui.success(`check passed: ${summary}, no drift detected.`);
  } else {
    await ui.info(`checked ${summary}.`);
  }
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
