import type { Catalog } from "../catalog/discover.js";
import type { Lockfile } from "../lockfile/schema.js";

// Update lockfile digests/metadata to match the current (repo) catalog state.
// Returns human-readable drift descriptions for anything that changed; the
// lockfile object is mutated in place.
export const refreshLockDigests = (
  catalog: Catalog,
  lock: Lockfile,
): string[] => {
  const drift: string[] = [];
  const skillByName = new Map(catalog.skills.map((s) => [s.name, s]));
  const commandByName = new Map(catalog.commands.map((c) => [c.name, c]));
  const mcpByName = new Map(catalog.mcp.map((m) => [m.name, m]));

  for (const [id, entry] of Object.entries(lock.entries)) {
    if (entry.type === "skill") {
      const cat = skillByName.get(id.slice("skill:".length));
      if (!cat) continue;
      if (cat.digest !== entry.digest) {
        drift.push(`${id}: skill content changed`);
        entry.digest = cat.digest;
        entry.frontmatter = cat.frontmatter;
      }
    } else if (entry.type === "command") {
      const cat = commandByName.get(id.slice("command:".length));
      if (!cat) continue;
      if (cat.digest !== entry.digest) {
        drift.push(`${id}: command content changed`);
        entry.digest = cat.digest;
      }
    } else if (entry.type === "mcp") {
      const cat = mcpByName.get(id.slice("mcp:".length));
      if (!cat) continue;
      if (cat.configDigest !== entry.configDigest) {
        drift.push(`${id}: MCP server definition changed`);
        entry.configDigest = cat.configDigest;
        entry.transport = cat.server.transport;
      }
    }
  }

  return drift;
};
