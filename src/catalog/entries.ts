import type {
  CommandEntry,
  EntrySource,
  McpEntry,
  PluginEntry,
  SkillEntry,
} from "../lockfile/schema.js";
import type {
  CatalogCommand,
  CatalogMcp,
  CatalogPlugin,
  CatalogSkill,
} from "./discover.js";

export const skillToEntry = (
  skill: CatalogSkill,
  source: EntrySource,
): SkillEntry => ({
  type: "skill",
  installedPath: skill.sourcePath,
  source,
  digest: skill.digest,
  frontmatter: skill.frontmatter,
});

export const commandToEntry = (
  command: CatalogCommand,
  source: EntrySource,
): CommandEntry => ({
  type: "command",
  installedPath: command.sourcePath,
  source,
  digest: command.digest,
});

// MCP tool snapshot is filled in lazily by introspection (phase 4).
export const mcpToEntry = (mcp: CatalogMcp, source: EntrySource): McpEntry => ({
  type: "mcp",
  source,
  transport: mcp.server.transport,
  configDigest: mcp.configDigest,
  tools: null,
  toolsFetchedAt: null,
});

export const pluginToEntry = (
  plugin: CatalogPlugin,
  source: EntrySource,
): PluginEntry => ({
  type: "plugin",
  provider: plugin.provider,
  installedPath: plugin.sourcePath,
  source,
  digest: plugin.digest,
  requires: plugin.requires,
});
