import type { Catalog } from "../catalog/discover.js";
import * as ui from "../ui/prompts.js";

const DEFAULT_SKILLS = ["find-skills", "skill-creator"];
const DEFAULT_COMMANDS = ["cp", "review"];

export interface Selection {
  skills: string[];
  commands: string[];
  mcp: string[];
}

// One-line hint for a skill: "v1.2.3 · short description". Either part may be
// absent (most skills carry no version; cleanup has no frontmatter at all).
const skillHint = (fm: {
  description: string | null;
  version: string | null;
}): string => {
  const parts: string[] = [];
  if (fm.version) parts.push(`v${fm.version}`);
  if (fm.description) {
    const flat = fm.description.replace(/\s+/g, " ").trim();
    const max = 70;
    parts.push(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
  }
  return parts.join(" · ");
};

const serverDetail = (catalog: Catalog, name: string): string => {
  const entry = catalog.mcp.find((m) => m.name === name);
  if (!entry) return "";
  const s = entry.server;
  return s.transport === "http"
    ? s.url
    : [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
};

// Interactive (or all-on) selection across the three artifact kinds.
export const selectFromCatalog = async (
  catalog: Catalog,
  { interactive }: { interactive: boolean },
): Promise<Selection> => {
  const allSkills = catalog.skills.map((s) => s.name);
  const allCommands = catalog.commands.map((c) => c.name);
  const allMcp = catalog.mcp.map((m) => m.name);

  if (!interactive || !process.stdin.isTTY) {
    return { skills: allSkills, commands: allCommands, mcp: allMcp };
  }

  // Skills, grouped (general first, defaults surfaced).
  const groupNames = [...new Set(catalog.skills.map((s) => s.group))].sort(
    (a, b) => (a === "general" ? -1 : b === "general" ? 1 : a.localeCompare(b)),
  );
  const skillGroups = groupNames.map((name) => ({
    name,
    items: catalog.skills
      .filter((s) => s.group === name)
      .sort((a, b) => {
        if (name === "general") {
          const ad = DEFAULT_SKILLS.includes(a.name);
          const bd = DEFAULT_SKILLS.includes(b.name);
          if (ad !== bd) return ad ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((s) => {
        const hint = skillHint(s.frontmatter);
        return { value: s.name, label: s.name, ...(hint ? { hint } : {}) };
      }),
  }));

  const skills = catalog.skills.length
    ? await ui.selectGrouped({
        message: "Select skills (space toggles, a all, enter confirms)",
        groups: skillGroups,
        initialValues: allSkills.filter((s) => DEFAULT_SKILLS.includes(s)),
      })
    : [];

  const commands = catalog.commands.length
    ? await ui.selectGrouped({
        message: "Select commands (space toggles, a all, enter confirms)",
        groups: [
          {
            name: "commands",
            items: catalog.commands.map((c) => ({
              value: c.name,
              label: `/${c.name}`,
            })),
          },
        ],
        initialValues: allCommands.filter((c) => DEFAULT_COMMANDS.includes(c)),
      })
    : [];

  const remote = catalog.mcp.filter((m) => m.server.transport === "http");
  const local = catalog.mcp.filter((m) => m.server.transport !== "http");
  const mcpGroups = [
    { name: "remote", items: remote },
    { name: "local", items: local },
  ]
    .filter((g) => g.items.length)
    .map((g) => ({
      name: g.name,
      items: g.items.map((m) => ({
        value: m.name,
        label: m.name,
        hint: serverDetail(catalog, m.name),
      })),
    }));

  const mcp = catalog.mcp.length
    ? await ui.selectGrouped({
        message: "Select MCP servers (space toggles, a all, enter confirms)",
        groups: mcpGroups,
        initialValues: [],
      })
    : [];

  return { skills, commands, mcp };
};
