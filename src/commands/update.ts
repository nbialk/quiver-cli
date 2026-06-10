import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CliOptions } from "../cli.js";
import { loadCatalog, type Catalog } from "../catalog/discover.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { resolveCatalog } from "../catalog/resolve.js";
import { readLockfile, writeLockfile } from "../lockfile/io.js";
import {
  parseEntryId,
  type CommandEntry,
  type Lockfile,
  type McpEntry,
  type SkillEntry,
} from "../lockfile/schema.js";
import { writeProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";

type UpdateStatus =
  | "updated"
  | "up-to-date"
  | "local-changes"
  | "not-in-catalog";

interface UpdateReport {
  id: string;
  status: UpdateStatus;
}

// Pull newer catalog content into the repo's .agents/ for locked entries.
// Local modifications (repo digest != lock digest) are never overwritten
// unless --force is given. Targeted per entry: other artifacts are untouched.
export const update = async (options: CliOptions): Promise<void> => {
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

  const onlyId = options.positionals[0];
  if (onlyId && !lock.entries[onlyId]) {
    await ui.error(`${onlyId} is not installed (not found in quiver.lock).`);
    process.exitCode = 1;
    return;
  }

  const source = resolveCatalog(lock.catalog.source);
  const sourceCatalog = loadCatalog(source);
  const { catalog: repoCatalog } = loadRepoCatalog(
    options.targetRoot,
    lock.catalog.source,
  );

  const ids = onlyId ? [onlyId] : Object.keys(lock.entries).sort();
  const reports: UpdateReport[] = [];
  let changed = false;

  for (const id of ids) {
    const parsed = parseEntryId(id);
    const entry = lock.entries[id];
    if (!parsed || !entry) continue;
    const report = applyUpdate(
      options.targetRoot,
      parsed,
      entry,
      sourceCatalog,
      repoCatalog,
      lock,
      options.force,
    );
    if (report.status === "updated") changed = true;
    reports.push(report);
  }

  if (changed) {
    writeLockfile(options.targetRoot, lock);
    const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
    writeProviders(options.targetRoot, catalog, lock);
  }

  report(reports, options);
};

const applyUpdate = (
  targetRoot: string,
  parsed: { type: string; name: string },
  entry: SkillEntry | CommandEntry | McpEntry,
  sourceCatalog: Catalog,
  repoCatalog: Catalog,
  lock: Lockfile,
  force: boolean,
): UpdateReport => {
  const id = `${parsed.type}:${parsed.name}`;

  if (entry.type === "skill") {
    const src = sourceCatalog.skills.find((s) => s.name === parsed.name);
    if (!src) return { id, status: "not-in-catalog" };
    if (src.digest === entry.digest) return { id, status: "up-to-date" };
    const repo = repoCatalog.skills.find((s) => s.name === parsed.name);
    if (repo && repo.digest !== entry.digest && !force) {
      return { id, status: "local-changes" };
    }
    const dest = resolve(targetRoot, ".agents", src.sourcePath);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src.absDir, dest, { recursive: true });
    entry.digest = src.digest;
    entry.frontmatter = src.frontmatter;
    entry.sourcePath = src.sourcePath;
    return { id, status: "updated" };
  }

  if (entry.type === "command") {
    const src = sourceCatalog.commands.find((c) => c.name === parsed.name);
    if (!src) return { id, status: "not-in-catalog" };
    if (src.digest === entry.digest) return { id, status: "up-to-date" };
    const repo = repoCatalog.commands.find((c) => c.name === parsed.name);
    if (repo && repo.digest !== entry.digest && !force) {
      return { id, status: "local-changes" };
    }
    const dest = resolve(targetRoot, ".agents", src.sourcePath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src.absPath, dest, { force: true });
    entry.digest = src.digest;
    entry.sourcePath = src.sourcePath;
    return { id, status: "updated" };
  }

  // MCP: replace this server's definition in the repo's .agents/config.json.
  const src = sourceCatalog.mcp.find((m) => m.name === parsed.name);
  if (!src) return { id, status: "not-in-catalog" };
  if (src.configDigest === entry.configDigest) return { id, status: "up-to-date" };
  const repo = repoCatalog.mcp.find((m) => m.name === parsed.name);
  if (repo && repo.configDigest !== entry.configDigest && !force) {
    return { id, status: "local-changes" };
  }
  const configPath = resolve(targetRoot, ".agents", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  config.mcpServers = { ...config.mcpServers, [parsed.name]: src.server };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  entry.configDigest = src.configDigest;
  entry.transport = src.server.transport;
  // Tool snapshot belongs to the old definition; re-baseline via check.
  entry.tools = null;
  entry.toolsFetchedAt = null;
  return { id, status: "updated" };
};

const report = (reports: UpdateReport[], options: CliOptions): void => {
  const by = (s: UpdateStatus): UpdateReport[] =>
    reports.filter((r) => r.status === s);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          updated: by("updated").map((r) => r.id),
          upToDate: by("up-to-date").map((r) => r.id),
          localChanges: by("local-changes").map((r) => r.id),
          notInCatalog: by("not-in-catalog").map((r) => r.id),
        },
        null,
        2,
      ),
    );
    return;
  }

  const c = ui.palette();
  const lines: string[] = [""];
  for (const r of by("updated")) lines.push(`  ${c.cyan("↑")} ${r.id}  updated`);
  for (const r of by("local-changes"))
    lines.push(
      `  ${c.yellow("▲")} ${r.id}  ${c.yellow("local changes - skipped (use --force)")}`,
    );
  for (const r of by("not-in-catalog"))
    lines.push(`  ${c.dim("•")} ${r.id}  ${c.dim("not in catalog")}`);
  for (const r of by("up-to-date"))
    lines.push(`  ${c.green("✓")} ${r.id}  ${c.dim("up to date")}`);

  const updated = by("updated").length;
  lines.push(
    "",
    `  ${
      updated
        ? c.cyan(`↑ ${updated} updated - review and commit .agents/ + quiver.lock`)
        : c.green("✓ everything up to date with the catalog")
    }`,
    "",
  );
  ui.block(lines);
};
