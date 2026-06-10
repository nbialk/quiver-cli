import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

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

export interface CatalogConfig {
  shared?: Record<string, unknown>;
  mcpServers?: Record<string, McpServer>;
  claude?: { settings?: unknown };
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

export interface Catalog {
  config: CatalogConfig;
  configPath: string;
  skills: CatalogSkill[];
  commands: CatalogCommand[];
  mcp: CatalogMcp[];
}

const readConfig = (root: string): { config: CatalogConfig; path: string } => {
  const path = resolve(root, "config.json");
  if (!existsSync(path)) return { config: {}, path };
  return { config: JSON.parse(readFileSync(path, "utf8")) as CatalogConfig, path };
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
          sourcePath: relative(root, childDir),
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
      return {
        name: file.replace(/\.md$/, ""),
        sourcePath: relative(root, absPath),
        absPath,
        digest: fileDigest(absPath),
      };
    });
};

const discoverMcp = (config: CatalogConfig): CatalogMcp[] => {
  const servers = config.mcpServers ?? {};
  return Object.keys(servers)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      server: servers[name]!,
      configDigest: jsonDigest(servers[name]),
    }));
};

export const loadCatalog = (catalog: ResolvedCatalog): Catalog => {
  const { config, path } = readConfig(catalog.root);
  return {
    config,
    configPath: path,
    skills: discoverSkills(catalog.root),
    commands: discoverCommands(catalog.root),
    mcp: discoverMcp(config),
  };
};
