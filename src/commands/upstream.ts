import { cpSync, rmSync } from "node:fs";

import type { CliOptions } from "../cli.js";
import { loadCatalog } from "../catalog/discover.js";
import { resolveCatalog } from "../catalog/resolve.js";
import {
  evaluateOrigin,
  fetchLatestCommit,
  fetchUpstreamDir,
  loadUpstreams,
  writeUpstreams,
  type UpstreamReport,
} from "../catalog/upstreams.js";
import { loadEnvLocal } from "../secrets/interpolate.js";
import * as ui from "../ui/prompts.js";

// Check source repos for skill updates. Runs against the bundled catalog (not a
// target repo): records a baseline commit per tracked skill on first run, then
// reports upstream drift on subsequent runs. `upstream pull [skill]` replaces
// catalog copies with the latest upstream content.
export const upstream = async (options: CliOptions): Promise<void> => {
  // Pick up a GITHUB_TOKEN from the repo's .env.local if present (env and the
  // gh CLI are also tried, in resolveGithubToken).
  loadEnvLocal(options.targetRoot);

  if (options.positionals[0] === "pull") {
    await pull(options);
    return;
  }

  const resolved = resolveCatalog();
  const catalog = loadCatalog(resolved);
  const upstreams = loadUpstreams(resolved);

  const trackedNames = Object.keys(upstreams);
  const catalogSkillNames = new Set(catalog.skills.map((s) => s.name));
  const untracked = catalog.skills
    .map((s) => s.name)
    .filter((n) => !trackedNames.includes(n))
    .sort((a, b) => a.localeCompare(b));

  const reports: UpstreamReport[] = [];
  let mapChanged = false;

  for (const name of trackedNames.sort((a, b) => a.localeCompare(b))) {
    const origin = upstreams[name]!;
    const result = await fetchLatestCommit(origin);
    const { report, changed } = evaluateOrigin(name, origin, result);
    if (changed) mapChanged = true;
    reports.push(report);
  }

  if (mapChanged) writeUpstreams(resolved, upstreams);

  const hasDrift = reports.some(
    (r) => r.status === "drift" || r.status === "drift-curated",
  );

  // Tracked origins whose skill no longer exists in the catalog.
  const stale = trackedNames.filter((n) => !catalogSkillNames.has(n));

  if (options.json) {
    console.log(
      JSON.stringify({ ok: !hasDrift, skills: reports, untracked, stale }, null, 2),
    );
    if (hasDrift) process.exitCode = 1;
    return;
  }

  await report(reports, untracked, stale);
  if (hasDrift) process.exitCode = 1;
};

// Status display order: actionable first, then noise.
const STATUS_ORDER: Record<UpstreamReport["status"], number> = {
  drift: 0,
  "drift-curated": 1,
  skipped: 2,
  baseline: 3,
  ok: 4,
};

type PullStatus =
  | "pulled"
  | "up-to-date"
  | "curated-skipped"
  | "not-in-catalog"
  | "error";

interface PullReport {
  name: string;
  status: PullStatus;
  detail?: string;
}

// Replace catalog skill copies with the latest upstream content (sparse git
// clone), then record the new baseline commit. Curated skills are skipped
// unless --force is given.
const pull = async (options: CliOptions): Promise<void> => {
  const resolved = resolveCatalog();
  const catalog = loadCatalog(resolved);
  const upstreams = loadUpstreams(resolved);

  const only = options.positionals[1];
  if (only && !upstreams[only]) {
    await ui.error(`${only} is not tracked in upstreams.json.`);
    process.exitCode = 1;
    return;
  }
  const names = only
    ? [only]
    : Object.keys(upstreams).sort((a, b) => a.localeCompare(b));

  const reports: PullReport[] = [];
  let mapChanged = false;

  for (const name of names) {
    const origin = upstreams[name]!;
    const skill = catalog.skills.find((s) => s.name === name);
    if (!skill) {
      reports.push({ name, status: "not-in-catalog" });
      continue;
    }
    if (origin.curated && !options.force) {
      reports.push({
        name,
        status: "curated-skipped",
        detail: "modified after import - use --force to overwrite",
      });
      continue;
    }

    const latest = await fetchLatestCommit(origin);
    if (!latest.ok) {
      reports.push({ name, status: "error", detail: latest.reason });
      continue;
    }
    if (origin.commit === latest.sha && !options.force) {
      reports.push({ name, status: "up-to-date" });
      continue;
    }

    const fetched = fetchUpstreamDir(origin);
    if (!fetched.ok) {
      reports.push({ name, status: "error", detail: fetched.reason });
      continue;
    }
    try {
      rmSync(skill.absDir, { recursive: true, force: true });
      cpSync(fetched.dir, skill.absDir, { recursive: true, dereference: true });
    } finally {
      fetched.cleanup();
    }
    origin.commit = latest.sha;
    origin.fetchedAt = new Date().toISOString();
    mapChanged = true;
    reports.push({ name, status: "pulled", detail: latest.sha.slice(0, 10) });
  }

  if (mapChanged) writeUpstreams(resolved, upstreams);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, skills: reports }, null, 2));
    return;
  }

  const c = ui.palette();
  const lines: string[] = [""];
  for (const r of reports) {
    if (r.status === "pulled")
      lines.push(`  ${c.cyan("↓")} ${r.name}  pulled @ ${r.detail}`);
    else if (r.status === "up-to-date")
      lines.push(`  ${c.green("✓")} ${r.name}  ${c.dim("up to date")}`);
    else if (r.status === "curated-skipped")
      lines.push(`  ${c.yellow("▲")} ${r.name}  ${c.yellow(r.detail ?? "curated")}`);
    else if (r.status === "not-in-catalog")
      lines.push(`  ${c.dim("•")} ${r.name}  ${c.dim("not in catalog")}`);
    else lines.push(`  ${c.red("✗")} ${r.name}  ${c.red(r.detail ?? "error")}`);
  }
  const pulled = reports.filter((r) => r.status === "pulled").length;
  lines.push(
    "",
    `  ${
      pulled
        ? c.cyan(`↓ ${pulled} pulled - review, rebuild and commit the catalog`)
        : c.green("✓ nothing to pull")
    }`,
    "",
  );
  ui.block(lines);
};

const report = async (
  reports: UpstreamReport[],
  untracked: string[],
  stale: string[],
): Promise<void> => {
  const c = ui.palette();
  const sorted = [...reports].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.name.localeCompare(b.name),
  );

  // Symbol + short label per status.
  const mark: Record<UpstreamReport["status"], string> = {
    drift: c.yellow("▲"),
    "drift-curated": c.yellow("▲"),
    skipped: c.dim("•"),
    baseline: c.cyan("+"),
    ok: c.green("✓"),
  };

  const nameWidth = Math.max(0, ...reports.map((r) => r.name.length));
  const lines: string[] = [""];

  for (const r of sorted) {
    const name = r.name.padEnd(nameWidth);
    const where = c.dim(`${r.repo}/${r.path}`);
    let detail: string;
    switch (r.status) {
      case "ok":
        detail = `up to date  ${c.dim(r.from ?? "")}`;
        break;
      case "baseline":
        detail = `baseline    ${c.dim(r.to ?? "")}`;
        break;
      case "skipped":
        detail = c.dim(`skipped     ${r.reason ?? ""}`);
        break;
      case "drift":
        detail = c.yellow(`UPDATED     ${r.from} → ${r.to}`);
        break;
      case "drift-curated":
        detail = c.yellow(`UPDATED     ${r.from} → ${r.to}  (curated)`);
        break;
    }
    lines.push(`  ${mark[r.status]} ${c.bold(name)}  ${detail}  ${where}`);
  }

  ui.block(lines);

  // Drift detail / next steps, only when there is action to take.
  const drifted = sorted.filter(
    (r) => r.status === "drift" || r.status === "drift-curated",
  );
  if (drifted.length) {
    const hint: string[] = [""];
    for (const r of drifted) {
      const note =
        r.status === "drift-curated"
          ? "curated — reconcile changes by hand"
          : "re-fetch with the skills CLI, then copy into the catalog";
      hint.push(`  ${c.yellow(r.name)}: ${c.dim(note)}`);
    }
    ui.block(hint);
  }

  // Footer: a single summary line, then optional untracked/stale lines.
  const counts = countByStatus(reports);
  const summaryParts: string[] = [];
  if (counts.drift) summaryParts.push(c.yellow(`${counts.drift} updated`));
  if (counts.baseline) summaryParts.push(c.cyan(`${counts.baseline} new`));
  if (counts.skipped) summaryParts.push(c.dim(`${counts.skipped} skipped`));
  if (counts.ok) summaryParts.push(c.green(`${counts.ok} up to date`));

  const lead = counts.drift === 0 ? c.green("✓") : c.yellow("▲");
  const footer: string[] = [""];
  footer.push(
    `  ${lead} ${c.bold(`${reports.length} tracked`)}` +
      (summaryParts.length ? `  ${summaryParts.join(c.dim(" · "))}` : ""),
  );
  if (untracked.length) {
    footer.push(`  ${c.dim(`untracked: ${untracked.join(", ")}`)}`);
  }
  if (stale.length) {
    footer.push(`  ${c.yellow(`stale origins: ${stale.join(", ")}`)}`);
  }
  ui.block([...footer, ""]);
};

interface StatusCounts {
  drift: number;
  baseline: number;
  skipped: number;
  ok: number;
}

const countByStatus = (reports: UpstreamReport[]): StatusCounts => {
  const counts: StatusCounts = { drift: 0, baseline: 0, skipped: 0, ok: 0 };
  for (const r of reports) {
    if (r.status === "drift" || r.status === "drift-curated") counts.drift += 1;
    else if (r.status === "baseline") counts.baseline += 1;
    else if (r.status === "skipped") counts.skipped += 1;
    else if (r.status === "ok") counts.ok += 1;
  }
  return counts;
};
