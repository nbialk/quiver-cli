import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile } from "../lockfile/io.js";
import {
  parseEntryId,
  type CommandEntry,
  type EntrySource,
  type McpEntry,
  type PluginEntry,
  type SkillEntry,
} from "../lockfile/schema.js";
import { formatTokens, sumTokens } from "../mcp/tokens.js";
import { requirementLabel } from "../plugins/requirements.js";
import { checkDependency, dependencyLabel } from "../plugins/check.js";
import { disabledMcpServers } from "../providers/local-config.js";
import * as ui from "../ui/prompts.js";

const truncate = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  if (max < 1) return "";
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

// Right-pad on visible width, then colorize, so ANSI codes never break column
// alignment.
const padCell = (text: string, width: number, color: (s: string) => string): string =>
  color(text.padEnd(width));

const origin = (source: EntrySource): string => {
  if (source.kind === "github") {
    return `github:${source.repo}${source.path ? `/${source.path}` : ""}#${source.ref ?? "default"} @ ${source.commit.slice(0, 12)}`;
  }
  if (source.kind === "local") {
    return `local: ${source.root}${source.path ? `/${source.path}` : ""}`;
  }
  return `legacy (unverified): ${source.catalog.source}` +
    (source.sourcePath ? `, path ${source.sourcePath}` : "") +
    (source.catalog.ref ? `, ref ${source.catalog.ref}` : "") +
    (source.catalog.resolved ? ` @ ${source.catalog.resolved.slice(0, 12)}` : "");
};

// Show what is installed according to quiver.lock, including MCP tool counts
// from the recorded snapshots.
export const list = async (options: CliOptions): Promise<void> => {
  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    if (options.json) console.log(JSON.stringify({
      ok: false,
      error: { code: "no-lockfile", message: "No quiver.lock found. Run `quiver-cli init` first." },
    }));
    else await ui.error("No quiver.lock found. Run `quiver-cli init` first.");
    process.exitCode = 2;
    return;
  }

  // MCP server details (url/command) live in the repo catalog, not the lock.
  const serverDetail = new Map<string, string>();
  const skillMetadata = new Map<string, { digest: string; frontmatter: SkillEntry["frontmatter"] }>();
  if (repoCatalogExists(options.targetRoot)) {
    const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
    for (const skill of catalog.skills) skillMetadata.set(skill.name, skill);
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
  const plugins: { name: string; entry: PluginEntry }[] = [];
  for (const [id, entry] of Object.entries(lock.entries)) {
    const p = parseEntryId(id);
    if (!p) continue;
    if (entry.type === "skill") {
      const local = skillMetadata.get(p.name);
      // Reparse metadata cached by older CLI versions only for matching content.
      // Keep list read-only and preserve locked metadata when local files drift.
      skills.push({ name: p.name, entry: local?.digest === entry.digest
        ? { ...entry, frontmatter: local.frontmatter } : entry });
    }
    else if (entry.type === "command") commands.push({ name: p.name, entry });
    else if (entry.type === "mcp") mcp.push({ name: p.name, entry });
    else if (entry.type === "plugin") plugins.push({ name: p.name, entry });
  }
  for (const group of [skills, commands, mcp, plugins] as { name: string }[][]) {
    group.sort((a, b) => a.name.localeCompare(b.name));
  }

  const disabled = disabledMcpServers(options.targetRoot);
  const dependencies = new Map(await Promise.all(plugins.map(async ({ name, entry }) => [
    name,
    await Promise.all(entry.requires.map((requirement) => checkDependency(`plugin:${name}`, requirement, false))),
  ] as const)));

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skills: skills.map(({ name, entry }) => ({
            name,
            source: entry.source,
            version: entry.frontmatter.version,
            description: entry.frontmatter.description,
          })),
          commands: commands.map(({ name, entry }) => ({ name, source: entry.source })),
          mcp: mcp.map(({ name, entry }) => ({
            name,
            source: entry.source,
            transport: entry.transport,
            enabled: !disabled.has(name),
            detail: serverDetail.get(name) ?? null,
            toolCount: entry.tools ? Object.keys(entry.tools).length : null,
            tokenEstimate: entry.tools ? sumTokens(entry.tools) : null,
            authRequired: entry.authRequired ?? false,
          })),
          plugins: plugins.map(({ name, entry }) => ({
            name,
            source: entry.source,
            provider: entry.provider,
            requires: entry.requires,
            dependencies: dependencies.get(name),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const c = ui.palette();
  const term = process.stdout.columns ?? 80;
  const lines: string[] = [""];

  if (skills.length) {
    const nameW = Math.max(...skills.map((e) => e.name.length));
    const verW = Math.max(
      1,
      ...skills.map((e) =>
        e.entry.frontmatter.version ? e.entry.frontmatter.version.length : 1,
      ),
    );
    // 4 indent + nameW + 1 gap + verW + 1 gap = description start column.
    const descMax = Math.min(55, term - (4 + nameW + 1 + verW + 1) - 1);
    lines.push(`  ${c.bold(`Skills · ${skills.length}`)}`);
    for (const { name, entry } of skills) {
      const ver = entry.frontmatter.version
        ? padCell(entry.frontmatter.version, verW, c.cyan)
        : padCell("—", verW, c.dim);
      const desc = entry.frontmatter.description
        ? c.dim(truncate(entry.frontmatter.description, descMax))
        : "";
      lines.push(`    ${name.padEnd(nameW)} ${ver} ${desc}`.trimEnd());
      if (options.verbose) lines.push(`      ${c.dim(origin(entry.source))}`);
    }
  }

  if (commands.length) {
    lines.push("", `  ${c.bold(`Commands · ${commands.length}`)}`);
    for (const { name, entry } of commands) {
      lines.push(`    /${name}`);
      if (options.verbose) lines.push(`      ${c.dim(origin(entry.source))}`);
    }
  }

  let missingTools = false;
  const needsAuth: string[] = [];
  if (mcp.length) {
    const nameW = Math.max(...mcp.map((e) => e.name.length));
    const toolW = Math.max(
      ...mcp.map((e) => {
        const n = e.entry.tools ? Object.keys(e.entry.tools).length : null;
        return `${n ?? "?"} ${n === 1 ? "tool" : "tools"}`.length;
      }),
    );
    const tokenCell = (entry: McpEntry): string => {
      const total = entry.tools ? sumTokens(entry.tools) : null;
      return total === null ? "? tok" : formatTokens(total);
    };
    const tokW = Math.max(...mcp.map((e) => tokenCell(e.entry).length));
    lines.push("", `  ${c.bold(`MCP · ${mcp.length}`)}`);
    for (const { name, entry } of mcp) {
      const count = entry.tools ? Object.keys(entry.tools).length : null;
      const tokenTotal = entry.tools ? sumTokens(entry.tools) : null;
      if (count === null) {
        if (entry.authRequired) needsAuth.push(name);
        else missingTools = true;
      } else if (tokenTotal === null) {
        // Snapshot predates token estimates; check backfills them.
        missingTools = true;
      }
      const tools = padCell(
        `${count ?? "?"} ${count === 1 ? "tool" : "tools"}`,
        toolW,
        count === null ? c.dim : c.green,
      );
      const tokens = padCell(
        tokenCell(entry),
        tokW,
        tokenTotal === null ? c.dim : c.cyan,
      );
      const detail = serverDetail.get(name);
      const off = disabled.has(name) ? `  ${c.yellow("disabled")}` : "";
      lines.push(
        `    ${name.padEnd(nameW)} ${entry.transport} · ${tools} · ${tokens}` +
          (options.verbose && detail ? `  ${c.dim(detail)}` : "") +
          off,
      );
      if (options.verbose) lines.push(`      ${c.dim(origin(entry.source))}`);
    }
  }


  if (plugins.length) {
    lines.push("", `  ${c.bold(`Plugins · ${plugins.length}`)}`);
    for (const { name, entry } of plugins) {
      const requires = options.verbose && entry.requires.length
        ? `  ${c.dim(`requires: ${entry.requires.map(requirementLabel).join(", ")}`)}`
        : "";
      const reports = dependencies.get(name) ?? [];
      const summary = options.verbose ? "" : reports.map((dependency) =>
        ` · ${dependency.command}${dependency.installedVersion ? ` ${dependency.installedVersion}` : ""} ${dependency.status === "present" ? c.green("✓") : c.yellow(dependency.status)}`,
      ).join("");
      lines.push(`    ${name} ${c.dim(entry.provider)}${requires}${summary}`);
      for (const dependency of dependencies.get(name) ?? []) {
        if (options.verbose || dependency.status !== "present") {
          lines.push(`      ${c.dim(dependencyLabel(dependency))}`);
        }
      }
      if (options.verbose) lines.push(`      ${c.dim(origin(entry.source))}`);
    }
  }

  const providers = lock.providers?.length
    ? lock.providers.join(", ")
    : "claude, opencode, codex";
  lines.push(
    "",
    `  ${c.dim(`${providers.includes(",") ? "Providers" : "Provider"}: ${providers}`)}`,
  );
  for (const name of needsAuth) {
    lines.push(
      `  ${c.yellow(`${name} requires OAuth`)} ${c.dim(
        `— run 'opencode mcp auth ${name}', then 'quiver-cli check'`,
      )}`,
    );
  }
  if (missingTools) {
    lines.push(
      `  ${c.dim("review with 'quiver-cli check', then record snapshots with 'quiver-cli check mcp:<name> --accept'")}`,
    );
  }
  lines.push("");
  ui.block(lines);
};
