import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile } from "../lockfile/io.js";
import { parseEntryId } from "../lockfile/schema.js";
import { checkProviders } from "../providers/write.js";
import * as ui from "../ui/prompts.js";

export const status = async (options: CliOptions): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: "no-lockfile" }));
    else await ui.error("No quiver.lock found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }
  if (!repoCatalogExists(options.targetRoot)) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: "no-agents" }));
    else await ui.error("No .agents/ directory found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }

  const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);

  // Lockfile entries whose materialized source is missing.
  const haveSkills = new Set(catalog.skills.map((s) => s.name));
  const haveCommands = new Set(catalog.commands.map((c) => c.name));
  const haveMcp = new Set(catalog.mcp.map((m) => m.name));
  const missing: string[] = [];
  const changed: string[] = [];

  const skillByName = new Map(catalog.skills.map((s) => [s.name, s]));
  const commandByName = new Map(catalog.commands.map((c) => [c.name, c]));
  const mcpByName = new Map(catalog.mcp.map((m) => [m.name, m]));

  for (const [id, entry] of Object.entries(lock.entries)) {
    const p = parseEntryId(id);
    if (!p) continue;
    if (p.type === "skill") {
      if (!haveSkills.has(p.name)) missing.push(id);
      else if (entry.type === "skill" && skillByName.get(p.name)!.digest !== entry.digest)
        changed.push(id);
    } else if (p.type === "command") {
      if (!haveCommands.has(p.name)) missing.push(id);
      else if (entry.type === "command" && commandByName.get(p.name)!.digest !== entry.digest)
        changed.push(id);
    } else if (p.type === "mcp") {
      if (!haveMcp.has(p.name)) missing.push(id);
      else if (entry.type === "mcp" && mcpByName.get(p.name)!.configDigest !== entry.configDigest)
        changed.push(id);
    }
  }

  // Provider shim mismatches (out-of-sync / missing / stale generated files).
  const shimProblems = checkProviders(options.targetRoot, catalog, lock);

  const ok = missing.length === 0 && changed.length === 0 && shimProblems.length === 0;

  if (options.json) {
    console.log(JSON.stringify({ ok, missing, changed, shims: shimProblems }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  if (ok) {
    await ui.success("In sync: lockfile, .agents/ and provider shims agree.");
    return;
  }
  if (missing.length)
    await ui.warn(`Missing in .agents/: ${missing.join(", ")}`);
  if (changed.length)
    await ui.warn(`Content changed since lockfile: ${changed.join(", ")}`);
  if (shimProblems.length)
    await ui.warn(`Provider shims out of date:\n  - ${shimProblems.join("\n  - ")}`);
  await ui.info("Run `quiver-cli sync` to regenerate provider shims and refresh digests.");
  process.exitCode = 1;
};
