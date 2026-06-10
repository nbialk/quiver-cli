import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile } from "../lockfile/io.js";
import {
  parseEntryId,
  type CommandEntry,
  type McpEntry,
  type SkillEntry,
} from "../lockfile/schema.js";
import * as ui from "../ui/prompts.js";

const truncate = (s: string, max = 60): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

// Show what is installed according to quiver.lock, including MCP tool counts
// from the recorded snapshots.
export const list = async (options: CliOptions): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: "no-lockfile" }));
    else await ui.error("No quiver.lock found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }

  // MCP server details (url/command) live in the repo catalog, not the lock.
  const serverDetail = new Map<string, string>();
  if (repoCatalogExists(options.targetRoot)) {
    const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
    for (const mcp of catalog.mcp) {
      serverDetail.set(
        mcp.name,
        mcp.server.transport === "http"
          ? mcp.server.url
          : [mcp.server.command, ...(mcp.server.args ?? [])].join(" "),
      );
    }
  }

  const skills: { name: string; entry: SkillEntry }[] = [];
  const commands: { name: string; entry: CommandEntry }[] = [];
  const mcp: { name: string; entry: McpEntry }[] = [];
  for (const [id, entry] of Object.entries(lock.entries)) {
    const p = parseEntryId(id);
    if (!p) continue;
    if (entry.type === "skill") skills.push({ name: p.name, entry });
    else if (entry.type === "command") commands.push({ name: p.name, entry });
    else if (entry.type === "mcp") mcp.push({ name: p.name, entry });
  }
  for (const group of [skills, commands, mcp] as { name: string }[][]) {
    group.sort((a, b) => a.name.localeCompare(b.name));
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skills: skills.map(({ name, entry }) => ({
            name,
            version: entry.frontmatter.version,
            description: entry.frontmatter.description,
          })),
          commands: commands.map(({ name }) => ({ name })),
          mcp: mcp.map(({ name, entry }) => ({
            name,
            transport: entry.transport,
            detail: serverDetail.get(name) ?? null,
            toolCount: entry.tools ? Object.keys(entry.tools).length : null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const c = ui.palette();
  const lines: string[] = [""];
  const width = Math.max(
    0,
    ...[...skills, ...commands, ...mcp].map((e) => e.name.length + 1),
  );

  if (skills.length) {
    lines.push(`  ${c.bold("skills")}`);
    for (const { name, entry } of skills) {
      const version = entry.frontmatter.version
        ? c.cyan(`v${entry.frontmatter.version} `)
        : "";
      const desc = entry.frontmatter.description
        ? c.dim(truncate(entry.frontmatter.description))
        : "";
      lines.push(`    ${name.padEnd(width)} ${version}${desc}`);
    }
  }

  if (commands.length) {
    lines.push("", `  ${c.bold("commands")}`);
    for (const { name } of commands) {
      lines.push(`    /${name}`);
    }
  }

  if (mcp.length) {
    lines.push("", `  ${c.bold("mcp servers")}`);
    for (const { name, entry } of mcp) {
      const tools = entry.tools
        ? c.green(`${Object.keys(entry.tools).length} tools`)
        : c.dim("tools: ? (run check)");
      const detail = serverDetail.get(name);
      lines.push(
        `    ${name.padEnd(width)} ${entry.transport.padEnd(5)} ${tools}` +
          (detail ? `  ${c.dim(detail)}` : ""),
      );
    }
  }

  const providers = lock.providers?.length
    ? lock.providers.join(", ")
    : "claude, opencode, codex";
  lines.push(
    "",
    `  ${c.bold(
      `${skills.length} skills · ${commands.length} commands · ${mcp.length} MCP servers`,
    )}  ${c.dim(`providers: ${providers}`)}`,
    "",
  );
  ui.block(lines);
};
