import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { Selection } from "../commands/select.js";
import type { EntryType } from "../lockfile/schema.js";
import { assertSafeMutationPath, resolveContainedPath } from "../path.js";
import { collectEnvVars } from "../secrets/interpolate.js";
import type { Catalog } from "./discover.js";
import type { ResolvedCatalog } from "./resolve.js";

// Copy the selected catalog artifacts from the (package) catalog into the
// target repo's .agents/ directory, so they are committed and provider symlinks
// resolve to repo-local paths (robust against npx cache clears / CI).
//
// Returns a ResolvedCatalog pointing at the repo-local .agents/ so callers can
// re-discover and write providers from the materialized source of truth.
export const materializeCatalog = (
  targetRoot: string,
  sourceCatalog: ResolvedCatalog,
  catalog: Catalog,
  selection: Selection,
): ResolvedCatalog => {
  const destRoot = resolve(targetRoot, ".agents");
  const selectedSourcePaths = [
    ...catalog.skills
      .filter((entry) => selection.skills.includes(entry.name))
      .map(
        (entry) =>
          [entry.sourcePath, `Skill "${entry.name}" sourcePath`] as const,
      ),
    ...catalog.commands
      .filter((entry) => selection.commands.includes(entry.name))
      .map(
        (entry) =>
          [entry.sourcePath, `Command "${entry.name}" sourcePath`] as const,
      ),
    ...catalog.plugins
      .filter((entry) => selection.plugins.includes(entry.name))
      .map(
        (entry) =>
          [entry.sourcePath, `Plugin "${entry.name}" sourcePath`] as const,
      ),
  ];
  const selectedMcpServers = Object.fromEntries(
    catalog.mcp
      .filter((entry) => selection.mcp.includes(entry.name))
      .map((entry) => [entry.name, entry.server]),
  );
  const envVars = collectEnvVars(selectedMcpServers);
  const exampleDest = resolve(targetRoot, ".env.local.example");

  for (const [sourcePath, label] of selectedSourcePaths) {
    const dest = resolveContainedPath(destRoot, sourcePath, label);
    assertSafeMutationPath(targetRoot, dest, "Catalog output");
  }
  for (const path of [
    resolve(destRoot, "config.json"),
    ...["AGENTS.md", "README.md"]
      .filter((file) => existsSync(resolve(sourceCatalog.root, file)))
      .map((file) => resolve(destRoot, file)),
  ]) {
    assertSafeMutationPath(targetRoot, path, "Catalog output");
  }
  if (envVars.length && !existsSync(exampleDest)) {
    assertSafeMutationPath(targetRoot, exampleDest, "Secrets template output");
  }
  mkdirSync(destRoot, { recursive: true });

  // Skills: copy each selected skill dir, preserving its catalog-relative path
  // (e.g. skills/code/cleanup) so groups are retained.
  const keptSkillDirs: string[] = [];
  for (const skill of catalog.skills) {
    if (!selection.skills.includes(skill.name)) continue;
    const dest = resolveContainedPath(
      destRoot,
      skill.sourcePath,
      `Skill "${skill.name}" sourcePath`,
    );
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(skill.absDir, dest, { recursive: true, force: true });
    keptSkillDirs.push(skill.sourcePath);
  }

  // Commands: copy each selected command file.
  for (const command of catalog.commands) {
    if (!selection.commands.includes(command.name)) continue;
    const dest = resolveContainedPath(
      destRoot,
      command.sourcePath,
      `Command "${command.name}" sourcePath`,
    );
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(command.absPath, dest, { force: true });
  }

  // Provider plugins: copy selected source files into the repo catalog.
  for (const plugin of catalog.plugins) {
    if (!selection.plugins.includes(plugin.name)) continue;
    const dest = resolveContainedPath(
      destRoot,
      plugin.sourcePath,
      `Plugin "${plugin.name}" sourcePath`,
    );
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(plugin.absPath, dest, { force: true });
  }

  // Filtered config.json: keep only selected MCP servers/plugins, plus shared
  // provider overlays.
  const filteredConfig: Record<string, unknown> = {};
  if (catalog.config.shared) filteredConfig["shared"] = catalog.config.shared;
  const mcpServers: Record<string, unknown> = selectedMcpServers;
  if (Object.keys(mcpServers).length) filteredConfig["mcpServers"] = mcpServers;
  const plugins: Record<string, unknown> = {};
  for (const plugin of catalog.plugins) {
    if (!selection.plugins.includes(plugin.name)) continue;
    plugins[plugin.name] = catalog.config.plugins?.[plugin.name];
  }
  if (Object.keys(plugins).length) filteredConfig["plugins"] = plugins;
  if (catalog.config.opencode) filteredConfig["opencode"] = catalog.config.opencode;
  if (catalog.config.tui) filteredConfig["tui"] = catalog.config.tui;
  if (catalog.config.claude) filteredConfig["claude"] = catalog.config.claude;
  writeFileSync(
    resolve(destRoot, "config.json"),
    JSON.stringify(filteredConfig, null, 2) + "\n",
  );

  // Static docs shipped by the catalog.
  for (const file of ["AGENTS.md", "README.md"]) {
    const src = resolve(sourceCatalog.root, file);
    if (existsSync(src)) {
      cpSync(src, resolve(destRoot, file), { force: true });
    }
  }

  // Secrets template: generated from the ${VAR} placeholders the *selected*
  // MCP servers actually reference. No secrets needed -> no file. Never
  // clobbers an existing one.
  if (envVars.length && !existsSync(exampleDest)) {
    writeFileSync(exampleDest, envExampleContent(envVars));
  }

  return { source: sourceCatalog.source, root: destRoot };
};

export const materializeCatalogEntry = (
  targetRoot: string,
  catalog: Catalog,
  type: EntryType,
  name: string,
): void => {
  const destRoot = resolve(targetRoot, ".agents");

  if (type === "skill") {
    const skill = catalog.skills.find((candidate) => candidate.name === name)!;
    const dest = resolveContainedPath(
      destRoot,
      skill.sourcePath,
      `Skill "${skill.name}" sourcePath`,
    );
    assertSafeMutationPath(targetRoot, dest, "Catalog output");
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(skill.absDir, dest, { recursive: true, force: true });
    return;
  }

  if (type === "command") {
    const command = catalog.commands.find(
      (candidate) => candidate.name === name,
    )!;
    const dest = resolveContainedPath(
      destRoot,
      command.sourcePath,
      `Command "${command.name}" sourcePath`,
    );
    assertSafeMutationPath(targetRoot, dest, "Catalog output");
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(command.absPath, dest, { force: true });
    return;
  }

  const configPath = resolve(destRoot, "config.json");
  assertSafeMutationPath(targetRoot, configPath, "Catalog config output");
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};

  if (type === "mcp") {
    const mcp = catalog.mcp.find((candidate) => candidate.name === name)!;
    const mcpServers = {
      ...(config["mcpServers"] as Record<string, unknown> | undefined),
      [name]: mcp.server,
    };
    config["mcpServers"] = mcpServers;
    const envVars = collectEnvVars(mcpServers);
    const exampleDest = resolve(targetRoot, ".env.local.example");
    if (envVars.length && !existsSync(exampleDest)) {
      assertSafeMutationPath(targetRoot, exampleDest, "Secrets template output");
    }
    mkdirSync(destRoot, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    if (envVars.length && !existsSync(exampleDest)) {
      writeFileSync(exampleDest, envExampleContent(envVars));
    }
    return;
  }

  const plugin = catalog.plugins.find((candidate) => candidate.name === name)!;
  const dest = resolveContainedPath(
    destRoot,
    plugin.sourcePath,
    `Plugin "${plugin.name}" sourcePath`,
  );
  assertSafeMutationPath(targetRoot, dest, "Catalog output");
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(plugin.absPath, dest, { force: true });
  config["plugins"] = {
    ...(config["plugins"] as Record<string, unknown> | undefined),
    [name]: catalog.config.plugins?.[name],
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
};

const envExampleContent = (vars: string[]): string =>
  [
    "# Secrets for the selected MCP servers (generated by quiver).",
    "# Copy to `.env.local` (gitignored), fill in the values, then re-run",
    "# `quiver-cli sync`. Never commit `.env.local`.",
    "",
    ...vars.map((v) => `${v}=`),
    "",
  ].join("\n");

// Remove a skill/command artifact from the materialized repo .agents/, cleaning
// up empty group folders. Used by `remove`.
export const removeArtifact = (
  targetRoot: string,
  sourcePath: string,
): void => {
  const agentsRoot = resolve(targetRoot, ".agents");
  const path = resolveContainedPath(
    agentsRoot,
    sourcePath,
    "Lockfile sourcePath",
  );
  assertSafeMutationPath(targetRoot, path, "Artifact removal", true);
  rmSync(path, { recursive: true, force: true });
};
