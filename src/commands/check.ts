import type { CliOptions } from "../cli.js";
import { jsonDigest } from "../catalog/digest.js";
import { repoCatalogExists } from "../catalog/repo.js";
import {
  lockfilePath,
  readLockfile,
  requireV2Lockfile,
  writeLockfile,
} from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import { diffSnapshots, isEmptyDiff, type ToolDiff } from "../mcp/diff.js";
import { introspect } from "../mcp/introspect.js";
import { findOpencodeToken } from "../mcp/opencode-auth.js";
import { toSnapshot } from "../mcp/snapshot.js";
import { assertSafeMutationPath } from "../path.js";
import { checkDependency, dependencyLabel, type DependencyReport } from "../plugins/check.js";
import { disabledMcpServers } from "../providers/local-config.js";
import { checkProviders } from "../providers/write.js";
import { interpolateEnvVars, loadEnvLocal } from "../secrets/interpolate.js";
import * as ui from "../ui/prompts.js";
import {
  acceptLocalEntries,
  inspectLocalEntries,
  type LocalDriftItem,
  type LocalIssue,
} from "./locksync.js";
import { checkSourceUpdates, type SourceUpdateReport } from "./update-plan.js";

export { hasCommand } from "../plugins/check.js";

interface PluginRequirementIssue {
  id: string;
  command: string;
}

interface McpReport {
  id: string;
  status: "ok" | "missing-baseline" | "skipped" | "error" | "drift" | "accepted";
  baseline: "present" | "missing";
  intentional?: boolean;
  reason?: string;
  authRequired?: boolean;
  diff?: ToolDiff;
  tokens?: number;
}

interface CheckReport {
  ok: boolean;
  complete: boolean;
  status: "ok" | "drift" | "incomplete";
  checked: CheckedCounts;
  skillDrift: LocalDriftItem[];
  configDrift: LocalDriftItem[];
  missing: LocalIssue[];
  unsafe: LocalIssue[];
  accepted: string[];
  acceptanceBlocked: boolean;
  pluginRequirements: PluginRequirementIssue[];
  pluginDependencies: DependencyReport[];
  sourceUpdates: SourceUpdateReport[];
  shims: string[];
  mcp: McpReport[];
}

export const check = async (options: CliOptions): Promise<void> => {
  const progress = await ui.progress(!options.json);
  try {
    await runCheck(options, progress);
  } finally {
    progress.clear();
  }
};

const runCheck = async (options: CliOptions, progress: ui.Progress): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    return fail(options, "no-lockfile", "No quiver.lock found. Run `quiver-cli init` first.");
  }
  if (!repoCatalogExists(options.targetRoot)) {
    return fail(options, "no-agents", "No .agents/ directory found. Run `quiver-cli init` first.");
  }

  const [target] = options.positionals;
  if (options.positionals.length > 1 || (target && options.all)) {
    return fail(options, "invalid-target", "Select exactly one installed id or --all, not both.");
  }
  if (target && (!parseEntryId(target) || !Object.hasOwn(lock.entries, target))) {
    return fail(options, "not-installed", `Not installed: ${target}. Use an installed id such as skill:name or mcp:name.`);
  }
  if (options.accept) {
    if (!target && !options.all) {
      return fail(options, "accept-target-required", "Use `quiver-cli check <id> --accept` or `quiver-cli check --all --accept`.");
    }
    try {
      requireV2Lockfile(lock);
      assertSafeMutationPath(options.targetRoot, lockfilePath(options.targetRoot), "Lockfile");
    } catch (error) {
      return fail(options, "accept-not-allowed", error instanceof Error ? error.message : String(error));
    }
  }

  const initialLockDigest = options.accept ? jsonDigest(lock) : null;
  loadEnvLocal(options.targetRoot);
  let local;
  try {
    progress.update("Checking local files and provider configuration…");
    local = inspectLocalEntries(options.targetRoot, lock);
  } catch (error) {
    progress.clear();
    return fail(options, "invalid-local-content", error instanceof Error ? error.message : String(error));
  }
  const { catalog } = local;
  const selected = new Set(target ? [target] : Object.keys(lock.entries));
  const missing = local.missing.filter((item) => selected.has(item.id));
  const unsafe = local.unsafe.filter((item) => selected.has(item.id));
  const acceptanceBlocked = options.accept && (missing.length > 0 || unsafe.length > 0);
  const accepting = options.accept && !acceptanceBlocked;
  const accepted = accepting ? [...selected] : [];
  const drift = local.drift.filter((item) => selected.has(item.id) && !accepting);
  const skillDrift = drift.filter((item) => item.kind === "content");
  const configDrift = drift.filter((item) => item.kind === "config");

  const skillByName = new Map(catalog.skills.map((s) => [s.name, s]));
  const commandByName = new Map(catalog.commands.map((c) => [c.name, c]));
  const pluginByName = new Map(catalog.plugins.map((p) => [p.name, p]));
  const mcpByName = new Map(catalog.mcp.map((m) => [m.name, m]));
  const pluginRequirements: PluginRequirementIssue[] = [];
  const pluginDependencies: DependencyReport[] = [];
  const checked = { skills: 0, commands: 0, mcp: 0, plugins: 0 };

  for (const id of selected) {
    const entry = lock.entries[id]!;
    const p = parseEntryId(id);
    if (!p) continue;
    if (entry.type === "skill") {
      if (skillByName.has(p.name)) checked.skills += 1;
    } else if (entry.type === "command") {
      if (commandByName.has(p.name)) checked.commands += 1;
    } else if (entry.type === "plugin") {
      const cat = pluginByName.get(p.name);
      if (!cat) continue;
      checked.plugins += 1;
      if (lock.providers?.length && !lock.providers.includes(cat.provider)) {
        continue;
      }
      for (const requirement of cat.requires) {
        progress.update(`Checking ${id} dependencies…`);
        const dependency = await checkDependency(id, requirement, !options.offline);
        progress.clear();
        if (!options.json) await reportDependency(dependency);
        pluginDependencies.push(dependency);
        if (dependency.status === "missing") pluginRequirements.push({ id, command: dependency.command });
      }
    } else if (mcpByName.has(p.name)) {
      checked.mcp += 1;
    }
  }

  // --- Provider shim drift (out-of-sync / missing / stale generated files) --
  progress.update("Checking provider configuration…");
  const shimProblems = checkProviders(options.targetRoot, catalog, lock);
  progress.clear();
  if (!options.json) await ui.info("Local file and provider checks complete.");

  const mcpReports: McpReport[] = [];
  const disabled = disabledMcpServers(options.targetRoot);
  const initialLocalDigest = accepting
    ? jsonDigest({ local, disabled: [...disabled].sort() })
    : null;

  for (const id of selected) {
    const entry = lock.entries[id]!;
    if (entry.type !== "mcp") continue;
    const p = parseEntryId(id)!;
    const catMcp = mcpByName.get(p.name);
    if (!catMcp) continue;
    if (accepting && entry.configDigest !== catMcp.configDigest) {
      // Tools and auth observations belong to the configuration they came from.
      entry.tools = null;
      entry.toolsFetchedAt = null;
      delete entry.authRequired;
    }
    const baseline = entry.tools ? "present" : "missing";
    const skipReason = options.offline
      ? "offline"
      : disabled.has(p.name)
        ? "disabled locally"
        : catMcp.server.transport === "stdio" && !options.introspectStdio
          ? "stdio server skipped (pass --introspect-stdio to run it)"
          : null;
    if (skipReason || acceptanceBlocked) {
      if (!options.json && !skipReason) await ui.warn(`${id}: acceptance blocked by missing or unsafe local content`);
      mcpReports.push({
        id,
        status: "skipped",
        baseline,
        intentional: Boolean(skipReason),
        reason: skipReason ?? "acceptance blocked by missing or unsafe local content",
      });
      continue;
    }

    progress.update(`Checking ${id} tool snapshot…`);
    const server = interpolateEnvVars(catMcp.server);
    // OAuth-protected HTTP servers: reuse opencode's access token (read-only).
    const cred =
      server.transport === "http"
        ? findOpencodeToken(p.name, server.url)
        : ({ status: "none" } as const);
    let res;
    try {
      res = await introspect(server, {
        allowStdio: options.introspectStdio,
        authToken: cred.status === "ok" ? cred.accessToken : undefined,
      });
    } catch (error) {
      res = { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
    progress.clear();
    if (!res.ok) {
      if (accepting && res.authRequired) entry.authRequired = true;
      const reason = res.authRequired ? authHint(cred.status, p.name) : res.reason;
      if (!options.json) await ui.warn(`${id}: ${reason}`);
      mcpReports.push({
        id,
        status: res.authRequired ? "skipped" : "error",
        baseline,
        intentional: false,
        reason,
        ...(res.authRequired ? { authRequired: true } : {}),
      });
      continue;
    }

    const current = toSnapshot(res.tools);
    const tokens = Object.values(current).reduce((sum, tool) => sum + (tool.tokens ?? 0), 0);
    const diff = entry.tools ? diffSnapshots(entry.tools, current) : undefined;
    if (accepting) {
      entry.tools = current;
      entry.toolsFetchedAt = new Date().toISOString();
      if (
        cred.status !== "ok" &&
        (server.transport === "stdio" ||
          !Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === "authorization"))
      ) {
        delete entry.authRequired;
      }
      mcpReports.push({ id, status: "accepted", baseline: "present", tokens, ...(diff ? { diff } : {}) });
    } else if (!diff) {
      mcpReports.push({ id, status: "missing-baseline", baseline, tokens });
    } else if (isEmptyDiff(diff)) {
      mcpReports.push({ id, status: "ok", baseline, tokens });
    } else {
      mcpReports.push({ id, status: "drift", baseline, tokens, diff });
    }
    if (!options.json) await ui.info(`${id}: ${accepting ? "snapshot checked (acceptance pending)" : mcpReports[mcpReports.length - 1]!.status}`);
  }

  progress.clear();
  const sourceWidth = Math.max(0, ...[...selected].map((id) => id.length));
  if (!options.json && !options.offline && selected.size) ui.block(["Source updates:"]);
  const sourceUpdates = await checkSourceUpdates(options, lock, [...selected].sort(), options.json || options.offline ? undefined : {
    start: (id, completed, total) => progress.update(`Checking ${id} source… ${completed}/${total} complete`),
    complete: (result) => {
      progress.clear();
      reportSourceUpdates([result], "item", sourceWidth);
    },
  });
  progress.clear();

  if (accepting && selected.size) {
    try {
      assertSafeMutationPath(options.targetRoot, lockfilePath(options.targetRoot), "Lockfile");
      const currentLock = readLockfile(options.targetRoot);
      if (!currentLock || jsonDigest(currentLock) !== initialLockDigest ||
          jsonDigest({
            local: inspectLocalEntries(options.targetRoot, currentLock),
            disabled: [...disabledMcpServers(options.targetRoot)].sort(),
          }) !== initialLocalDigest) {
        throw new Error("Check inputs changed");
      }
    } catch {
      return fail(
        options,
        "concurrent-change",
        "quiver.lock or local .agents content changed while checking. No baselines were accepted. " +
          `Retry \`quiver-cli check ${target ?? "--all"} --accept\` after other edits finish.`,
      );
    }
    acceptLocalEntries(catalog, lock, selected);
    writeLockfile(options.targetRoot, lock);
  }

  const hasDrift =
    skillDrift.length > 0 ||
    configDrift.length > 0 ||
    pluginRequirements.length > 0 ||
    pluginDependencies.some((item) => item.status === "incompatible") ||
    shimProblems.length > 0 ||
    mcpReports.some((r) => r.status === "drift");
  const complete =
    missing.length === 0 && unsafe.length === 0 &&
    pluginDependencies.every((item) => item.status !== "unknown" && item.freshness !== "unknown") &&
    sourceUpdates.every((item) => item.status !== "error" && item.status !== "legacy") &&
    mcpReports.every((r) => r.status === "ok" || r.status === "drift" || r.status === "accepted");
  const hasProblems =
    hasDrift || missing.length > 0 || unsafe.length > 0 ||
    pluginDependencies.some((item) => item.status === "unknown") ||
    sourceUpdates.some((item) => item.status === "error") ||
    mcpReports.some((r) =>
      r.status === "error" || r.status === "missing-baseline" ||
      (r.status === "skipped" && !r.intentional));
  const result: CheckReport = {
    ok: !hasProblems,
    complete,
    status: hasDrift ? "drift" : hasProblems || !complete ? "incomplete" : "ok",
    checked,
    skillDrift,
    configDrift,
    missing,
    unsafe,
    accepted,
    acceptanceBlocked,
    pluginRequirements,
    pluginDependencies,
    sourceUpdates,
    shims: shimProblems,
    mcp: mcpReports,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    await report(result, options);
  }
  if (hasProblems) process.exitCode = 1;
};

export interface CheckedCounts {
  skills: number;
  commands: number;
  mcp: number;
  plugins: number;
}

const report = async (
  result: CheckReport,
  options: CliOptions,
): Promise<void> => {
  const {
    skillDrift,
    configDrift,
    pluginDependencies,
    shims: shimProblems,
    mcp: mcpReports,
    checked,
  } = result;
  for (const [label, issues] of [
    ["Missing locked entries", result.missing],
    ["Unsafe local entries", result.unsafe],
  ] as const) {
    if (issues.length) {
      await ui.warn(`${label}:\n  - ${issues.map((item) => `${item.id}: ${item.reason}`).join("\n  - ")}`);
    }
  }
  if (result.acceptanceBlocked) {
    await ui.error("Acceptance not allowed for missing or unsafe local content; no baselines changed.");
  }
  if (skillDrift.length) {
    await ui.warn(
      `Managed content changed since lockfile:\n  - ${skillDrift
        .map((s) => s.id)
        .join("\n  - ")}`,
    );
  }

  if (configDrift.length) {
    await ui.warn(`MCP definitions changed since lockfile:\n  - ${configDrift.map((item) => item.id).join("\n  - ")}`);
  }

  reportSourceUpdates(result.sourceUpdates, "summary");

  if (shimProblems.length) {
    await ui.warn(
      `Provider shims out of date:\n  - ${shimProblems.join("\n  - ")}`,
    );
  }

  // Other skipped servers (e.g. stdio without --introspect-stdio) are the
  // common, expected case - collapse them into a single line instead of one each.
  const skipped = mcpReports.filter(
    (r) => r.status === "skipped" && r.intentional,
  );
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

  for (const r of mcpReports.filter((item) => item.baseline === "missing")) {
    await ui.warn(
      `${r.id}: no recorded tool baseline. Run \`quiver-cli check ${r.id} --accept\` to record a snapshot.`,
    );
  }

  if (result.accepted.length) {
    await ui.info(`Accepted local baselines: ${result.accepted.join(", ")}. Source baselines were not changed.`);
  }

  const drifted = mcpReports.filter((r) => r.status === "drift");
  for (const r of drifted) {
    if (!r.diff) continue;
    await ui.warn(`${r.id}: tool drift\n  - ${driftLines(r.diff, options.verbose).join("\n  - ")}`);
  }

  const summary = summarize(checked);
  const outdated = pluginDependencies.filter((item) => item.freshness === "outdated").length;
  if (outdated) await ui.info(`${outdated} dependency update${outdated === 1 ? "" : "s"} available; update external binaries with their own installer or package manager.`);
  if (result.ok && result.complete) {
    await ui.success(`check passed: ${summary}, no drift detected.`);
  } else {
    await ui.info(`checked ${summary}${result.status === "drift" ? ", drift detected" : ""}${!result.complete ? ", check incomplete" : ""}.`);
    if (skillDrift.length || configDrift.length || shimProblems.length || drifted.length) {
      await recommend([...skillDrift, ...configDrift], shimProblems, drifted);
    }
  }
};

const reportDependency = async (dependency: DependencyReport): Promise<void> => {
  if (["missing", "incompatible", "unknown", "outdated"].includes(dependency.status)) {
    await ui.warn(dependencyLabel(dependency));
  } else {
    await ui.info(dependencyLabel(dependency));
  }
};

const reportSourceUpdates = (updates: SourceUpdateReport[], mode: "item" | "summary", width = 0): void => {
  if (!updates.length) return;
  if (updates.every((item) => item.status === "skipped")) {
    ui.block(["Source updates: not checked (--offline)."]);
    return;
  }
  const color = ui.palette();
  const labels: Record<SourceUpdateReport["status"], string> = {
    "up-to-date": "Source up to date",
    "update-available": "Update available",
    pinned: "Pinned to a fixed commit",
    legacy: "Unknown (legacy source)",
    skipped: "Not checked (offline)",
    error: "Source check failed",
  };
  const lines: string[] = [];
  for (const item of mode === "item" ? updates : []) {
    const icon = item.status === "error" ? color.red("✖")
      : item.status === "legacy" || item.status === "update-available" ? color.yellow("⚠") : color.green("✔");
    lines.push(`  ${icon} ${item.id.padEnd(width)}   ${item.scope === "adapter" ? "Adapter: " : ""}${labels[item.status]}${item.localChanges ? " · local customizations preserved" : ""}`);
    if (item.reason && item.status !== "up-to-date" && item.status !== "pinned") {
      lines.push(...item.reason.split(/\r?\n/).map((line) => `    ${line}`));
    }
  }
  if (mode === "item") {
    ui.block(lines);
    return;
  }
  const available = updates.filter((item) => item.status === "update-available").length;
  const blocked = updates.filter((item) => item.blocked).length;
  lines.push(`Source updates: ${available} available · ${updates.filter((item) => item.status === "up-to-date").length} up to date · ${updates.filter((item) => item.status === "pinned").length} pinned · ${updates.filter((item) => item.status === "legacy" || item.status === "error").length} unknown`);
  if (available) lines.push("Run `quiver-cli update` to apply source updates, or `quiver-cli update --dry-run` to preview application.");
  if (blocked) lines.push(`${blocked} update${blocked === 1 ? " is" : "s are"} blocked by local customizations; review before using --force.`);
  ui.block(lines);
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
  localDrift: LocalDriftItem[],
  shimProblems: string[],
  drifted: McpReport[],
): Promise<void> => {
  const c = ui.palette();
  const lines: string[] = ["to resolve drift:"];
  if (shimProblems.length) {
    lines.push(`  ${c.cyan("quiver-cli sync")}   regenerate provider shims`);
  }
  if (drifted.length) {
    for (const item of drifted) {
      lines.push(`  ${c.cyan(`quiver-cli check ${item.id} --accept`)}   accept the observed MCP tool snapshot`);
    }
  }
  if (localDrift.length) {
    const ids = localDrift.map((s) => s.id);
    const one = ids.length === 1 ? ids[0] : "<id>";
    lines.push(
      `  ${c.cyan(`quiver-cli check ${one} --accept`)}   accept local changes without changing source provenance`,
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
  if (c.plugins) parts.push(plural(c.plugins, "plugin"));
  return parts.length ? parts.join(", ") : "nothing";
};

// Actionable skip reason for OAuth-protected servers, based on what we found
// in opencode's credential store.
export const authHint = (
  cred: "ok" | "expired" | "none",
  name: string,
): string => {
  const reauth = `run 'opencode mcp auth ${name}', then 'quiver-cli check'`;
  if (cred === "expired") return `OAuth token expired — re-${reauth}`;
  if (cred === "ok") return `OAuth token rejected — re-${reauth}`;
  return `requires OAuth — ${reauth}`;
};

const truncate = (s: string, max = 120): string =>
  s.length > max ? s.slice(0, max) + "…" : s;

const fail = async (
  options: CliOptions,
  code: string,
  message: string,
): Promise<void> => {
  if (options.json) console.log(JSON.stringify({ ok: false, complete: false, status: "error", error: code, message, accepted: [] }));
  else await ui.error(message);
  process.exitCode = 1;
};
