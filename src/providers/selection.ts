import type {
  Catalog,
  CatalogCommand,
  CatalogMcp,
  CatalogSkill,
} from "../catalog/discover.js";
import { parseEntryId, type Lockfile } from "../lockfile/schema.js";

export interface SelectedArtifacts {
  skills: CatalogSkill[];
  commands: CatalogCommand[];
  mcp: CatalogMcp[];
}

// Resolve the lockfile's selected entry ids against the catalog. Entries whose
// source no longer exists in the catalog are skipped (sync surfaces that drift).
export const resolveSelection = (
  catalog: Catalog,
  lock: Lockfile,
): SelectedArtifacts => {
  const skillNames = new Set<string>();
  const commandNames = new Set<string>();
  const mcpNames = new Set<string>();

  for (const id of Object.keys(lock.entries)) {
    const parsed = parseEntryId(id);
    if (!parsed) continue;
    if (parsed.type === "skill") skillNames.add(parsed.name);
    else if (parsed.type === "command") commandNames.add(parsed.name);
    else if (parsed.type === "mcp") mcpNames.add(parsed.name);
  }

  return {
    skills: catalog.skills.filter((s) => skillNames.has(s.name)),
    commands: catalog.commands.filter((c) => commandNames.has(c.name)),
    mcp: catalog.mcp.filter((m) => mcpNames.has(m.name)),
  };
};
