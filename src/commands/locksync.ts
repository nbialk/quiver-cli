import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { fileDigest, jsonDigest, treeDigest } from "../catalog/digest.js";
import { validateMcpServer, type Catalog, type CatalogConfig } from "../catalog/discover.js";
import { readFrontmatter } from "../catalog/frontmatter.js";
import { parseEntryId, type Lockfile } from "../lockfile/schema.js";
import { assertSafeMutationPath, resolveContainedPath } from "../path.js";
import { validatePluginRequirements } from "../plugins/requirements.js";

export interface LocalDriftItem {
  id: string;
  kind: "content" | "config";
}

export interface LocalIssue {
  id: string;
  reason: string;
}

// Inspect installed paths rather than rediscovering by name: a moved artifact
// must not conceal a missing locked path, and one missing plugin must not abort sync.
export const inspectLocalEntries = (targetRoot: string, lock: Lockfile) => {
  const root = resolve(targetRoot, ".agents");
  const configPath = resolve(root, "config.json");
  assertSafeMutationPath(targetRoot, configPath, "Local config");
  const configStat = lstatSync(configPath, { throwIfNoEntry: false });
  if (configStat && (!configStat.isFile() || configStat.nlink !== 1)) {
    throw new Error("Local .agents/config.json must be a regular file without hard links");
  }
  const parsedConfig: unknown = configStat
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  if (parsedConfig === null || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
    throw new Error("Local .agents/config.json must contain an object");
  }
  const config = parsedConfig as CatalogConfig;
  const catalog: Catalog = {
    config,
    configPath,
    skills: [],
    commands: [],
    mcp: [],
    plugins: [],
  };
  const drift: LocalDriftItem[] = [];
  const missing: LocalIssue[] = [];
  const unsafe: LocalIssue[] = [];

  for (const [id, entry] of Object.entries(lock.entries).sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = parseEntryId(id);
    if (!parsed) continue;
    const { name } = parsed;
    try {
      if (entry.type === "mcp") {
        const server = config.mcpServers?.[name];
        if (server === undefined) {
          missing.push({ id, reason: "MCP definition missing from .agents/config.json" });
          continue;
        }
        validateMcpServer(server, `MCP server "${name}"`);
        const configDigest = jsonDigest(server);
        catalog.mcp.push({ name, server, configDigest });
        if (configDigest !== entry.configDigest) {
          drift.push({ id, kind: "config" });
        }
        continue;
      }

      const path = resolveContainedPath(root, entry.installedPath, id);
      assertSafeMutationPath(targetRoot, path, id);
      const stat = lstatSync(path);
      let digest: string;
      if (entry.type === "skill") {
        if (!stat.isDirectory()) throw new Error("Installed skill is not a directory");
        digest = treeDigest(path);
        const fm = readFrontmatter(readFileSync(resolve(path, "SKILL.md"), "utf8"));
        catalog.skills.push({
          name,
          group: basename(dirname(path)) === "skills" ? "general" : basename(dirname(path)),
          sourcePath: entry.installedPath,
          absDir: path,
          digest,
          frontmatter: {
            name: fm["name"] ?? null,
            description: fm["description"] ?? null,
            version: fm["version"] ?? null,
          },
        });
      } else {
        if (!stat.isFile() || stat.nlink !== 1) {
          throw new Error("Installed artifact must be a regular file without hard links");
        }
        digest = fileDigest(path);
        if (entry.type === "command") {
          catalog.commands.push({ name, sourcePath: entry.installedPath, absPath: path, digest });
        } else {
          const plugin = config.plugins?.[name];
          if (!plugin) {
            missing.push({ id, reason: "Plugin definition missing from .agents/config.json" });
            continue;
          }
          if (
            resolveContainedPath(root, plugin.sourcePath, id) !== path ||
            plugin.provider !== "opencode"
          ) {
            throw new Error("Plugin definition does not match its installed path or is invalid");
          }
          validatePluginRequirements(plugin.requires === undefined ? [] : plugin.requires, `Plugin "${name}".requires`);
          digest = jsonDigest({ config: plugin, content: digest });
          catalog.plugins.push({
            name,
            provider: plugin.provider,
            sourcePath: entry.installedPath,
            absPath: path,
            digest,
            requires: plugin.requires ?? [],
          });
        }
      }
      if (digest !== entry.digest) drift.push({ id, kind: "content" });
    } catch (error) {
      const issue = { id, reason: error instanceof Error ? error.message : String(error) };
      if (
        error && typeof error === "object" && "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        missing.push(issue);
      } else {
        unsafe.push(issue);
      }
    }
  }

  return { catalog, drift, missing, unsafe };
};

// Only check --accept calls this; source provenance is deliberately untouched.
export const acceptLocalEntries = (
  catalog: Catalog,
  lock: Lockfile,
  ids: Set<string>,
): void => {
  for (const id of ids) {
    const entry = lock.entries[id]!;
    const { name } = parseEntryId(id)!;
    if (entry.type === "skill") {
      const cat = catalog.skills.find((item) => item.name === name)!;
      entry.digest = cat.digest;
      entry.frontmatter = cat.frontmatter;
    } else if (entry.type === "command") {
      entry.digest = catalog.commands.find((item) => item.name === name)!.digest;
    } else if (entry.type === "plugin") {
      const cat = catalog.plugins.find((item) => item.name === name)!;
      entry.digest = cat.digest;
      entry.provider = cat.provider;
      entry.requires = cat.requires;
    } else {
      const cat = catalog.mcp.find((item) => item.name === name)!;
      entry.configDigest = cat.configDigest;
      entry.transport = cat.server.transport;
    }
  }
};
