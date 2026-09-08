import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, win32 } from "node:path";

import { resolveContainedPath } from "../path.js";
import { fileDigest, jsonDigest, treeDigest } from "./digest.js";
import { readFrontmatter } from "./frontmatter.js";
import type { ResolvedCatalog } from "./resolve.js";

export interface HttpServer {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface StdioServer {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpServer = HttpServer | StdioServer;

export function validateMcpServer(
  value: unknown,
  label = "MCP server",
): asserts value is McpServer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const server = value as Record<string, unknown>;
  if (server.transport !== "http" && server.transport !== "stdio") {
    throw new Error(`${label}.transport must be "http" or "stdio"`);
  }
  const primary = server.transport === "http" ? "url" : "command";
  if (typeof server[primary] !== "string" || !server[primary].trim()) {
    throw new Error(`${label}.${primary} must be a nonempty string`);
  }
  if (server.args !== undefined &&
      (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`${label}.args must be an array of strings`);
  }
  for (const field of ["env", "headers"] as const) {
    const record = server[field];
    if (record === undefined) continue;
    if (
      record === null || typeof record !== "object" || Array.isArray(record) ||
      (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) ||
      Object.values(record).some((item) => typeof item !== "string")
    ) {
      throw new Error(`${label}.${field} must be a plain string-valued record`);
    }
  }
}

export interface CatalogConfig {
  shared?: Record<string, unknown>;
  mcpServers?: Record<string, McpServer>;
  plugins?: Record<string, PluginConfig>;
  opencode?: Record<string, unknown>;
  tui?: Record<string, unknown>;
  claude?: { settings?: unknown };
}

export interface PluginConfig {
  provider: "opencode";
  sourcePath: string;
  requires?: string[];
}

export interface CatalogSkill {
  name: string;
  group: string;
  /** Path relative to the catalog .agents root, e.g. "skills/code/cleanup". */
  sourcePath: string;
  absDir: string;
  digest: string;
  frontmatter: {
    name: string | null;
    description: string | null;
    version: string | null;
  };
}

export interface CatalogCommand {
  name: string;
  sourcePath: string;
  absPath: string;
  digest: string;
}

export interface CatalogMcp {
  name: string;
  server: McpServer;
  configDigest: string;
}

export interface CatalogPlugin {
  name: string;
  provider: "opencode";
  sourcePath: string;
  absPath: string;
  digest: string;
  requires: string[];
}

export interface Catalog {
  config: CatalogConfig;
  configPath: string;
  skills: CatalogSkill[];
  commands: CatalogCommand[];
  mcp: CatalogMcp[];
  plugins: CatalogPlugin[];
}

const readConfig = (root: string): { config: CatalogConfig; path: string } => {
  const path = resolve(root, "config.json");
  if (!existsSync(path)) return { config: {}, path };
  return { config: JSON.parse(readFileSync(path, "utf8")) as CatalogConfig, path };
};

const assertSafeEntryName = (name: string, type: string): void => {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    win32.isAbsolute(name)
  ) {
    throw new Error(`Invalid ${type} name "${name}": names must be a single path segment.`);
  }
};

// Recursively find every directory containing a SKILL.md. Top-level skills are
// grouped as "general"; nested skills use their immediate parent folder name.
const discoverSkills = (root: string): CatalogSkill[] => {
  const skillsRoot = resolve(root, "skills");
  if (!existsSync(skillsRoot)) return [];
  const found: CatalogSkill[] = [];

  const walk = (dir: string, group: string | null): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childDir = resolve(dir, entry.name);
      if (existsSync(resolve(childDir, "SKILL.md"))) {
        const fm = readFrontmatter(
          readFileSync(resolve(childDir, "SKILL.md"), "utf8"),
        );
        found.push({
          name: entry.name,
          group: group ?? "general",
           sourcePath: relative(root, childDir).replaceAll("\\", "/"),
          absDir: childDir,
          digest: treeDigest(childDir),
          frontmatter: {
            name: fm["name"] ?? null,
            description: fm["description"] ?? null,
            version: fm["version"] ?? null,
          },
        });
      } else {
        walk(childDir, group ?? entry.name);
      }
    }
  };
  walk(skillsRoot, null);

  // Guard against two skills resolving to the same flat shim name.
  const seen = new Map<string, string>();
  for (const skill of found) {
    assertSafeEntryName(skill.name, "skill");
    const prev = seen.get(skill.name);
    if (prev && prev !== skill.absDir) {
      throw new Error(
        `Duplicate skill name "${skill.name}": ${prev} and ${skill.absDir}`,
      );
    }
    seen.set(skill.name, skill.absDir);
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
};

const discoverCommands = (root: string): CatalogCommand[] => {
  const commandsRoot = resolve(root, "commands");
  if (!existsSync(commandsRoot)) return [];
  return readdirSync(commandsRoot)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const absPath = resolve(commandsRoot, file);
      const name = file.replace(/\.md$/, "");
      assertSafeEntryName(name, "command");
      return {
        name,
        sourcePath: relative(root, absPath).replaceAll("\\", "/"),
        absPath,
        digest: fileDigest(absPath),
      };
    });
};

const discoverMcp = (config: CatalogConfig): CatalogMcp[] => {
  const servers = config.mcpServers ?? {};
  return Object.keys(servers)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const server = servers[name];
      validateMcpServer(server, `MCP server "${name}"`);
      return { name, server, configDigest: jsonDigest(server) };
    });
};

const discoverPlugins = (root: string, config: CatalogConfig): CatalogPlugin[] =>
  Object.entries(config.plugins ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, plugin]) => {
      assertSafeEntryName(name, "plugin");
      const absPath = resolveContainedPath(
        root,
        plugin.sourcePath,
        `Plugin "${name}" sourcePath`,
      );
      if (!existsSync(absPath)) {
        throw new Error(`Plugin "${name}" source not found: ${absPath}`);
      }
      return {
        name,
        provider: plugin.provider,
        sourcePath: plugin.sourcePath,
        absPath,
        digest: jsonDigest({ config: plugin, content: fileDigest(absPath) }),
        requires: plugin.requires ?? [],
      };
    });

export const loadCatalog = (catalog: ResolvedCatalog): Catalog => {
  const { config, path } = readConfig(catalog.root);
  return {
    config,
    configPath: path,
    skills: discoverSkills(catalog.root),
    commands: discoverCommands(catalog.root),
    mcp: discoverMcp(config),
    plugins: discoverPlugins(catalog.root, config),
  };
};
