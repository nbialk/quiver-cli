import type {
  CommandEntry,
  McpEntry,
  SkillEntry,
} from "../lockfile/schema.js";
import type {
  CatalogCommand,
  CatalogMcp,
  CatalogSkill,
} from "./discover.js";

export const skillToEntry = (skill: CatalogSkill): SkillEntry => ({
  type: "skill",
  sourcePath: skill.sourcePath,
  digest: skill.digest,
  pin: null,
  frontmatter: skill.frontmatter,
});

export const commandToEntry = (command: CatalogCommand): CommandEntry => ({
  type: "command",
  sourcePath: command.sourcePath,
  digest: command.digest,
});

// MCP tool snapshot is filled in lazily by introspection (phase 4).
export const mcpToEntry = (mcp: CatalogMcp): McpEntry => ({
  type: "mcp",
  transport: mcp.server.transport,
  configDigest: mcp.configDigest,
  tools: null,
  toolsFetchedAt: null,
});
