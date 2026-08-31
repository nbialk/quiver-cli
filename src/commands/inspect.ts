import type { CliOptions } from "../cli.js";
import { loadRepoCatalog, repoCatalogExists } from "../catalog/repo.js";
import { readLockfile } from "../lockfile/io.js";
import type { McpEntry, McpToolSnapshot } from "../lockfile/schema.js";
import { formatTokens, sumTokens } from "../mcp/tokens.js";
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

// Most expensive first, so candidates for disabling stand out; tools without
// an estimate (pre-token lockfile) sink to the bottom.
const byCost = (
  a: { name: string; tool: McpToolSnapshot },
  b: { name: string; tool: McpToolSnapshot },
): number =>
  (b.tool.tokens ?? -1) - (a.tool.tokens ?? -1) || a.name.localeCompare(b.name);

// Show one MCP server's recorded tool snapshot: what it can do (descriptions)
// and what each tool costs in context tokens.
export const inspect = async (options: CliOptions): Promise<void> => {
  const arg = options.positionals[0];
  if (!arg) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: "missing-argument" }));
    } else {
      await ui.error("Usage: quiver-cli inspect <mcp-name>");
    }
    process.exitCode = 1;
    return;
  }
  const name = arg.startsWith("mcp:") ? arg.slice("mcp:".length) : arg;

  const lock = readLockfile(options.targetRoot);
  if (!lock) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: "no-lockfile" }));
    else await ui.error("No quiver.lock found. Run `quiver-cli init` first.");
    process.exitCode = 1;
    return;
  }

  const entry = lock.entries[`mcp:${name}`];
  if (!entry || entry.type !== "mcp") {
    const available = Object.keys(lock.entries)
      .filter((id) => id.startsWith("mcp:"))
      .map((id) => id.slice("mcp:".length))
      .sort();
    if (options.json) {
      console.log(
        JSON.stringify({ ok: false, error: "unknown-server", available }),
      );
    } else {
      await ui.error(
        `Unknown MCP server "${name}".` +
          (available.length ? ` Available: ${available.join(", ")}` : ""),
      );
    }
    process.exitCode = 1;
    return;
  }
  const mcpEntry: McpEntry = entry;

  // Server detail (url/command) lives in the repo catalog, not the lock.
  let detail: string | null = null;
  if (repoCatalogExists(options.targetRoot)) {
    const { catalog } = loadRepoCatalog(options.targetRoot, lock.catalog.source);
    const cat = catalog.mcp.find((m) => m.name === name);
    if (cat) {
      detail =
        cat.server.transport === "http"
          ? cat.server.url
          : [cat.server.command, ...(cat.server.args ?? [])].join(" ");
    }
  }

  const enabled = !disabledMcpServers(options.targetRoot).has(name);
  const tools = mcpEntry.tools
    ? Object.entries(mcpEntry.tools)
        .map(([toolName, tool]) => ({ name: toolName, tool }))
        .sort(byCost)
    : null;
  const total = mcpEntry.tools ? sumTokens(mcpEntry.tools) : null;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          name,
          transport: mcpEntry.transport,
          detail,
          enabled,
          authRequired: mcpEntry.authRequired ?? false,
          toolsFetchedAt: mcpEntry.toolsFetchedAt,
          toolCount: tools ? tools.length : null,
          tokenEstimate: total,
          tools: tools
            ? tools.map(({ name: toolName, tool }) => ({
                name: toolName,
                description: tool.description,
                tokens: tool.tokens ?? null,
                inputSchemaHash: tool.inputSchemaHash,
              }))
            : null,
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

  lines.push(
    `  ${c.bold(name)} ${mcpEntry.transport}` +
      (detail ? `  ${c.dim(detail)}` : "") +
      (enabled ? "" : `  ${c.yellow("disabled")}`),
  );

  if (!tools) {
    lines.push("", `  ${c.dim("no tool snapshot recorded yet")}`);
    if (mcpEntry.authRequired) {
      lines.push(
        `  ${c.yellow(`${name} requires OAuth`)} ${c.dim(
          `— run 'opencode mcp auth ${name}', then 'quiver-cli check'`,
        )}`,
      );
    } else {
      lines.push(`  ${c.dim("run 'quiver-cli check' to introspect this server")}`);
    }
    lines.push("");
    ui.block(lines);
    return;
  }

  const summary =
    `${tools.length} tools` + (total !== null ? ` · ${formatTokens(total)}` : "");
  lines.push(
    `  ${c.bold(summary)}` +
      (mcpEntry.toolsFetchedAt
        ? `  ${c.dim(`snapshot from ${mcpEntry.toolsFetchedAt}`)}`
        : ""),
    "",
  );

  const nameW = Math.max(...tools.map((t) => t.name.length));
  const tokW = Math.max(
    ...tools.map(({ tool }) =>
      (tool.tokens === undefined ? "? tok" : formatTokens(tool.tokens)).length,
    ),
  );
  // 4 indent + nameW + 2 gap + tokW + 2 gap = description start column.
  const descMax = term - (4 + nameW + 2 + tokW + 2) - 1;
  let missingTokens = false;
  for (const { name: toolName, tool } of tools) {
    if (tool.tokens === undefined) missingTokens = true;
    const tokens = padCell(
      tool.tokens === undefined ? "? tok" : formatTokens(tool.tokens),
      tokW,
      tool.tokens === undefined ? c.dim : c.cyan,
    );
    if (options.verbose) {
      lines.push(`    ${c.bold(toolName.padEnd(nameW))}  ${tokens}`);
      for (const descLine of tool.description.split("\n")) {
        lines.push(`      ${c.dim(descLine)}`);
      }
      lines.push("");
    } else {
      lines.push(
        `    ${toolName.padEnd(nameW)}  ${tokens}  ${c.dim(
          truncate(tool.description, descMax),
        )}`.trimEnd(),
      );
    }
  }

  if (!options.verbose) lines.push("");
  lines.push(`  ${c.dim("token counts are chars/4 estimates of name + description + input schema")}`);
  if (!options.verbose) {
    lines.push(`  ${c.dim("use --verbose for full descriptions")}`);
  }
  if (missingTokens) {
    lines.push(
      `  ${c.dim("run 'quiver-cli check' to populate missing token estimates")}`,
    );
  }
  lines.push("");
  ui.block(lines);
};
