import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CliOptions } from "../cli.js";
import { loadCatalog, type CatalogConfig } from "../catalog/discover.js";
import { readSkillReferences } from "../catalog/index.js";
import { DEFAULT_CATALOG_SOURCE, resolveCatalog } from "../catalog/resolve.js";
import { emptyLockfile, writeLockfile } from "../lockfile/io.js";
import { assertSafeMutationPath } from "../path.js";
import { resolveProviders } from "../providers/resolve.js";
import { writeProviders } from "../providers/write.js";
import { prepareCatalogEntry, type PreparedEntry } from "../sources/entry.js";
import * as ui from "../ui/prompts.js";
import { ignoredSourcePaths, patchGitignore } from "./gitignore.js";
import { installPreparedEntry, validateAdditions } from "./install.js";
import { inspectLocalEntries } from "./locksync.js";
import { selectFromCatalog } from "./select.js";

export const init = async (options: CliOptions): Promise<void> => {
  const root = options.targetRoot;
  const preflight = (): void => {
    if (lstatSync(resolve(root, "quiver.lock"), { throwIfNoEntry: false })) {
      throw new Error("quiver.lock already exists. Use `quiver-cli add/remove` to change installed entries; init never replaces a lockfile, even with --force.");
    }
    for (const path of [
      ".agents/config.json", "quiver.lock", ".gitignore", ".env.local",
      ".env.local.example", ".agents/AGENTS.md", ".agents/config.local.json",
    ]) {
      const absolute = resolve(root, path);
      assertSafeMutationPath(root, absolute, "Init output");
      const stat = lstatSync(absolute, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1)) {
        throw new Error(`Cannot initialize: ${path} must be a regular file without hard links.`);
      }
    }
    for (const guide of ["AGENTS.md", "CLAUDE.md"]) {
      assertSafeMutationPath(root, resolve(root, guide), "Root guide", true);
    }
  };
  preflight();
  const providers = await resolveProviders(options);
  if (!options.empty && !options.all && (options.json || !process.stdin.isTTY)) {
    throw new Error("Init selection requires an interactive terminal. Use `quiver-cli init --empty` for a local setup or `quiver-cli init --all` to explicitly select all catalog entries. --yes only confirms provider defaults.");
  }

  const catalogSource = options.catalog ?? DEFAULT_CATALOG_SOURCE;
  const lock = emptyLockfile(catalogSource);
  lock.providers = providers;
  const configPath = resolve(root, ".agents/config.json");
  const guidePath = resolve(root, ".agents/AGENTS.md");
  let config: CatalogConfig = {};
  let guide: Buffer | undefined;
  let prepared: PreparedEntry[] = [];
  if (!options.empty) {
    if (!options.json) await ui.banner();
    const source = await resolveCatalog(catalogSource);
    const catalog = loadCatalog(source);
    const references = readSkillReferences(source.root, catalog);
    const selection = await selectFromCatalog({
      ...catalog, skills: [...catalog.skills, ...references],
    }, { interactive: !options.all, providers });
    const ids = [
      ...selection.skills.map((name) => `skill:${name}`),
      ...selection.commands.map((name) => `command:${name}`),
      ...selection.mcp.map((name) => `mcp:${name}`),
      ...selection.plugins.map((name) => `plugin:${name}`),
    ];
    prepared = await Promise.all(ids.map((id) => prepareCatalogEntry(source, catalog, id, references)));
    lock.catalog.ref = source.ref ?? null;
    lock.catalog.resolved = source.resolved ?? null;
    lock.catalog.fetchedAt = source.fetchedAt ?? lock.catalog.fetchedAt;
    config = Object.fromEntries(["shared", "opencode", "tui", "claude"]
      .filter((key) => Object.hasOwn(catalog.config, key))
      .map((key) => [key, catalog.config[key as keyof CatalogConfig]]));
    if (!lstatSync(guidePath, { throwIfNoEntry: false })) {
      const sourceGuide = resolve(source.root, "AGENTS.md");
      assertSafeMutationPath(source.root, sourceGuide, "Catalog guide");
      const stat = lstatSync(sourceGuide, { throwIfNoEntry: false });
      if (stat) {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Catalog AGENTS.md must be a regular file without hard links.");
        guide = readFileSync(sourceGuide);
      }
    }
  }
  preflight();
  validateAdditions(root, lock, prepared);

  mkdirSync(resolve(root, ".agents"), { recursive: true });
  if (!lstatSync(configPath, { throwIfNoEntry: false })) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  }
  if (guide !== undefined) writeFileSync(guidePath, guide, { flag: "wx" });
  writeLockfile(root, lock);
  for (const candidate of prepared) installPreparedEntry(root, lock, candidate);
  writeProviders(root, inspectLocalEntries(root, lock).catalog, lock);
  patchGitignore(root, providers);

  const installed = prepared.map(({ id }) => id);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, installed, providers }));
  } else {
    const ignored = ignoredSourcePaths(root);
    if (ignored.length) {
      await ui.warn(`Source of truth is gitignored: ${ignored.join(", ")}. Remove those .gitignore entries so fresh clones include it.`);
    }
    await ui.success(`Initialized ${installed.length} entries for ${providers.join(", ")}. Commit .agents/ and quiver.lock.`);
  }
};
