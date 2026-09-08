import type { CliOptions } from "../cli.js";
import { loadCatalog } from "../catalog/discover.js";
import { readSkillReferences } from "../catalog/index.js";
import { resolveCatalog } from "../catalog/resolve.js";
import { readLockfile, requireV2Lockfile } from "../lockfile/io.js";
import { PROVIDERS } from "../lockfile/schema.js";
import { writeProviders } from "../providers/write.js";
import {
  prepareCatalogEntry,
  prepareDirectSkill,
  resolveCatalogId,
  type PreparedEntry,
} from "../sources/entry.js";
import * as ui from "../ui/prompts.js";
import { installPreparedEntry, validateAdditions } from "./install.js";
import { inspectLocalEntries } from "./locksync.js";
import { selectFromCatalog, type SelectableCatalog } from "./select.js";

export const add = async (options: CliOptions): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) throw new Error("No quiver.lock found. Run `quiver-cli init` first.");
  requireV2Lockfile(lock);

  const input = options.positionals[0];
  const direct = input?.startsWith("github:");
  if (options.positionals.length > 1 || (options.all && input)) {
    throw new Error("Usage: quiver-cli add [<id|github:owner/repo[/path][#ref]>] or quiver-cli add --all, not both.");
  }
  if (options.name != null && !direct) {
    throw new Error("--name is only supported for a direct GitHub skill: quiver-cli add github:owner/repo[/path][#ref] --name=alias.");
  }
  if (!input && !options.all && (options.json || !process.stdin.isTTY)) {
    throw new Error("No entry selected. Use `quiver-cli add <id|github:owner/repo[/path][#ref]>`, an interactive terminal, or `quiver-cli add --all`. --yes does not select all entries.");
  }

  let prepared: PreparedEntry[] = [];
  const alreadyInstalled: string[] = [];
  if (direct) {
    const candidate = await prepareDirectSkill(input!, options.name ?? undefined);
    const installed = lock.entries[candidate.id];
    if (installed) {
      const previous = installed.source;
      const next = candidate.entry.source;
      const normalizeRef = (ref: string | null): string | null =>
        ref && /^[a-f0-9]{40}$/i.test(ref) ? ref.toLowerCase() : ref;
      if (previous.kind !== "github" || next.kind !== "github" ||
        previous.repo.toLowerCase() !== next.repo.toLowerCase() ||
        previous.path !== next.path || normalizeRef(previous.ref) !== normalizeRef(next.ref)) {
        throw new Error(`${candidate.id} is already installed from a different source. To retarget it explicitly, use \`quiver-cli update ${candidate.id} --source=${input}\`; add never overwrites installed entries.`);
      }
      alreadyInstalled.push(candidate.id);
    } else {
      prepared = [candidate];
    }
  } else if (input && Object.hasOwn(lock.entries, input)) {
    alreadyInstalled.push(input);
  } else {
    const source = await resolveCatalog(lock.catalog.source);
    const catalog = loadCatalog(source);
    const references = readSkillReferences(source.root, catalog);
    let ids: string[];
    if (input) {
      ids = [resolveCatalogId(input, catalog, references)];
    } else {
      const providers = lock.providers?.length ? lock.providers : [...PROVIDERS];
      const available: SelectableCatalog = {
        skills: [...catalog.skills, ...references].filter(({ name }) => !Object.hasOwn(lock.entries, `skill:${name}`)),
        commands: catalog.commands.filter(({ name }) => !Object.hasOwn(lock.entries, `command:${name}`)),
        mcp: catalog.mcp.filter(({ name }) => !Object.hasOwn(lock.entries, `mcp:${name}`)),
        plugins: catalog.plugins.filter(({ name, provider }) => !Object.hasOwn(lock.entries, `plugin:${name}`) && providers.includes(provider)),
      };
      const selection = await selectFromCatalog(available, { interactive: !options.all, providers });
      ids = [
        ...selection.skills.map((name) => `skill:${name}`),
        ...selection.commands.map((name) => `command:${name}`),
        ...selection.mcp.map((name) => `mcp:${name}`),
        ...selection.plugins.map((name) => `plugin:${name}`),
      ];
      if (!ids.length) throw new Error("No entries selected or available. Use `quiver-cli add <id|github:owner/repo[/path][#ref]>` or browse with `quiver-cli add`; --all explicitly selects remaining catalog entries.");
    }
    alreadyInstalled.push(...ids.filter((id) => Object.hasOwn(lock.entries, id)));
    prepared = await Promise.all(ids.filter((id) => !Object.hasOwn(lock.entries, id))
      .map((id) => prepareCatalogEntry(source, catalog, id, references)));
  }

  if (prepared.length) {
    validateAdditions(options.targetRoot, lock, prepared);
    for (const candidate of prepared) installPreparedEntry(options.targetRoot, lock, candidate);
    writeProviders(options.targetRoot, inspectLocalEntries(options.targetRoot, lock).catalog, lock);
  }
  const added = prepared.map(({ id }) => id);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, added, alreadyInstalled }));
  } else {
    if (added.length) await ui.success(`Added ${added.join(", ")}.`);
    if (alreadyInstalled.length) await ui.info(`Already installed: ${alreadyInstalled.join(", ")}.`);
  }
};
