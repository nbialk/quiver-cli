import { isAbsolute } from "node:path";
import process from "node:process";

import { readLockfile } from "./lockfile/io.js";
import { isProvider, parseEntryId, type Lockfile } from "./lockfile/schema.js";
import * as ui from "./ui/prompts.js";

export interface CliOptions {
  targetRoot: string;
  force: boolean;
  all: boolean;
  json: boolean;
  verbose: boolean;
  accept: boolean;
  offline: boolean;
  /** From --dry-run - report what would change without writing (update). */
  dryRun: boolean;
  introspectStdio: boolean;
  /** From --providers=a,b - validated by the consuming command. */
  providers: string[] | null;
  /** From --catalog=<source> - catalog source for init. */
  catalog: string | null;
  empty?: boolean;
  yes?: boolean;
  source?: string | null;
  name?: string | null;
  positionals: string[];
}

const HELP = `quiver-cli - compose agent skills, commands, plugins & MCP servers into any repo

Usage:
  quiver-cli <command> [options]

Commands:
  init             Select catalog entries, or start locally with --empty
  add [id|source]   Add catalog entries or a direct GitHub skill source
  remove <id>      Remove a single entry; keep lockfile + configs consistent
  disable <id>     Turn an MCP server off locally (mcp:<name>, gitignored override)
  enable <id>      Turn a locally disabled MCP server back on
  sync             Regenerate provider configs from .agents/ (warns on drift)
  providers [a,b]  Change which tools get configs (claude, opencode, codex)
  update [id]      Update installed entries from their own recorded sources
  list             Show installed entries, origins, and MCP tool counts
  inspect <name>   Show an MCP server's tools with descriptions and token cost
  check [id]       Check local consistency and available source/dependency updates
                   (--offline checks only local content and dependency versions)
  migrate          Migrate a V1 lockfile to V2 without fetching source content
  help             Show this help
  version          Show the quiver-cli version

Options:
  -f, --force          Discard local edits (update, remove)
  --all                Explicitly select everything (init, add, check)
  -y, --yes            Confirm defaults, not selection of all entries
  --empty              Initialize without a catalog or network access (init)
  --json               Machine-readable output (init, add, update, check,
                       migrate, list, inspect, help, version)
  -V, --verbose        Show full tool lists and description diffs (check);
                       full tool descriptions (inspect)
  --accept             Accept local baselines; requires an id or --all (check)
  --offline            Skip network checks; still check local plugin versions (check)
  --dry-run            Report what would change without writing (update, migrate)
  --providers=a,b      Generate configs only for these tools (init, providers)
  --catalog=<source>   Catalog source for init (e.g. github:owner/repo[/path][#ref])
  --source=<source>    Retarget one installed entry (update <id> only);
                       github:owner/repo[/path][#ref] or local:/absolute/path
  --name=<alias>       Set the installed name for a direct GitHub add
  --introspect-stdio   Allow introspecting stdio MCP servers (runs foreign code)
  -h, --help           Show help without running a command
  -v, --version        Show the quiver-cli version

Value options require '='. Installed entries may use a unique bare name or a
typed id (skill:name, command:name, mcp:name, plugin:name). Aliases: rm, ls.
`;

const KNOWN_FLAGS = new Set([
  "--force",
  "--all",
  "--yes",
  "--empty",
  "--json",
  "--verbose",
  "--accept",
  "--offline",
  "--dry-run",
  "--introspect-stdio",
]);

const FLAG_ALIASES: Record<string, string> = {
  "-f": "--force",
  "-y": "--yes",
  "-V": "--verbose",
};
const KNOWN_VALUE_FLAGS = new Set(["--providers", "--catalog", "--source", "--name"]);
const COMMAND_FLAGS: Record<string, string[]> = {
  init: ["--all", "--yes", "--empty", "--json", "--providers", "--catalog"],
  add: ["--all", "--yes", "--json", "--name"],
  remove: ["--force"],
  enable: [],
  disable: [],
  sync: [],
  providers: ["--providers", "--yes"],
  update: ["--force", "--yes", "--json", "--dry-run", "--source"],
  list: ["--json"],
  inspect: ["--json", "--verbose"],
  check: ["--all", "--json", "--verbose", "--accept", "--offline", "--introspect-stdio"],
  migrate: ["--json", "--dry-run"],
  help: ["--json"],
  version: ["--json", "--offline"],
};

const cliError = (code: string, message: string, exitCode = 2): Error =>
  Object.assign(new Error(message), { code, exitCode });

export const parse = (
  argv: string[],
): { command: string; options: CliOptions; unknownFlags: string[] } => {
  const options: CliOptions = {
    targetRoot: process.cwd(),
    force: false,
    all: false,
    yes: false,
    empty: false,
    json: argv.includes("--json"),
    verbose: false,
    accept: false,
    offline: false,
    dryRun: false,
    introspectStdio: false,
    providers: null,
    catalog: null,
    source: null,
    name: null,
    positionals: [],
  };
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return { command: "help", options, unknownFlags: [] };
  }

  const commandIndex = argv.findIndex((arg) => !arg.startsWith("-"));
  const versionFlags = argv.filter((arg) => arg === "--version" || arg === "-v");
  if (versionFlags.length > 1 || (versionFlags.length && commandIndex !== -1)) {
    throw cliError("usage", "Use version or --version on its own.");
  }
  const rawCommand = argv[commandIndex] ?? (versionFlags.length ? "version" : "help");
  const command = rawCommand === "rm" ? "remove" : rawCommand === "ls" ? "list" : rawCommand;
  const flags = new Map<string, string>();
  const unknownFlags: string[] = [];
  for (const [index, arg] of argv.entries()) {
    if (index === commandIndex || arg === "--version" || arg === "-v") continue;
    if (!arg.startsWith("-")) {
      if (!arg.trim()) throw cliError("usage", "Arguments must not be empty.");
      options.positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const key = FLAG_ALIASES[arg] ?? (equals < 0 ? arg : arg.slice(0, equals));
    if (!(equals < 0 ? KNOWN_FLAGS.has(key) : KNOWN_VALUE_FLAGS.has(key))) {
      unknownFlags.push(arg);
      continue;
    }
    if (flags.has(key)) throw cliError("usage", `Duplicate option: ${key}.`);
    const value = equals < 0 ? "" : arg.slice(equals + 1).trim();
    if (equals >= 0 && !value) throw cliError("usage", `${key} requires a nonempty value.`);
    flags.set(key, value);
  }

  options.force = flags.has("--force");
  options.all = flags.has("--all");
  options.yes = flags.has("--yes");
  options.empty = flags.has("--empty");
  options.verbose = flags.has("--verbose");
  options.accept = flags.has("--accept");
  options.offline = flags.has("--offline");
  options.dryRun = flags.has("--dry-run");
  options.introspectStdio = flags.has("--introspect-stdio");
  options.catalog = flags.get("--catalog") ?? null;
  options.source = flags.get("--source") ?? null;
  options.name = flags.get("--name") ?? null;
  const providerValue = flags.get("--providers");
  options.providers = providerValue === undefined ? null : providerValue.split(",").map((p) => p.trim());

  if (!Object.hasOwn(COMMAND_FLAGS, command)) {
    throw cliError("usage", `Unknown command: ${command}. Run quiver-cli help for available commands.`);
  }
  for (const flag of flags.keys()) {
    if (!COMMAND_FLAGS[command]!.includes(flag)) {
      throw cliError("usage", `${flag} is not supported by ${command}.` +
        (command === "sync" && flag === "--providers" ? " Use quiver-cli providers <a,b> instead." : ""));
    }
  }
  const count = options.positionals.length;
  const required = ["remove", "enable", "disable", "inspect"].includes(command);
  const optional = ["add", "update", "check", "providers"].includes(command);
  if ((required && count !== 1) || (optional && count > 1) || (!required && !optional && count)) {
    throw cliError("usage", `${command} takes ${required ? "exactly one" : optional ? "at most one" : "no"} positional argument.`);
  }
  if (options.providers) {
    if (options.providers.some((p) => !isProvider(p)) || new Set(options.providers).size !== options.providers.length) {
      throw cliError("usage", "--providers requires distinct providers from claude, opencode, codex.");
    }
  }
  if (command === "providers" && count) {
    const providers = options.positionals[0]!.split(",").map((p) => p.trim());
    if (options.providers || providers.some((p) => !isProvider(p)) || new Set(providers).size !== providers.length) {
      throw cliError("usage", "Supply distinct valid providers using either a positional list or --providers, not both.");
    }
  }
  if (options.empty && (options.all || options.catalog)) {
    throw cliError("usage", "--empty cannot be combined with --all or --catalog.");
  }
  if (command === "add" && options.all && count) {
    throw cliError("usage", "Use add --all without a positional argument.");
  }
  if (command === "check" && options.all && count) {
    throw cliError("usage", "Select an installed id or --all, not both.");
  }
  if (options.accept && !count && !options.all) {
    throw cliError("usage", "--accept requires an installed id or --all.");
  }
  if (options.offline && options.introspectStdio) {
    throw cliError("usage", "--offline cannot be combined with --introspect-stdio.");
  }
  if (options.source) {
    const github = options.source.startsWith("github:") && options.source !== "github:";
    const local = options.source.startsWith("local:") && isAbsolute(options.source.slice("local:".length));
    if (!count || (!github && !local)) {
      throw cliError("usage", "--source requires update <id> and a github: source or local:/absolute/path.");
    }
  }
  if (options.name && (!options.positionals[0]?.startsWith("github:") || !parseEntryId(`skill:${options.name}`) || options.all)) {
    throw cliError("usage", "--name requires a direct GitHub add with one valid alias, without --all.");
  }
  return { command, options, unknownFlags };
};

export const resolveInstalledId = (input: string, lock: Lockfile): string => {
  if (parseEntryId(input)) {
    if (Object.hasOwn(lock.entries, input)) return input;
  } else if (!input.includes(":")) {
    const matches = Object.keys(lock.entries).filter((id) => parseEntryId(id)?.name === input).sort();
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw cliError("ambiguous-id", `Ambiguous installed name "${input}". Use one of: ${matches.join(", ")}.`);
    }
  } else {
    throw cliError("invalid-id", `Invalid installed id "${input}". Use skill:name, command:name, mcp:name, or plugin:name.`);
  }
  throw cliError("not-installed", `"${input}" is not installed. Run quiver-cli list to see installed entries.`);
};

export const run = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  let options: CliOptions | undefined;
  try {
    const parsed = parse(argv);
    const { command, unknownFlags } = parsed;
    options = parsed.options;
    if (unknownFlags.length) {
      throw cliError("usage", `Unknown option(s): ${unknownFlags.join(", ")}. Value options require --option=value.`);
    }
    if (command === "help") {
      console.log(options.json ? JSON.stringify({ ok: true, help: HELP }) : HELP);
      return;
    }
    if (command === "version") {
      const { getCurrentVersion } = await import("./version/notifier.js");
      const version = getCurrentVersion();
      console.log(options.json ? JSON.stringify({ ok: true, version }) : version);
      return;
    }

    if (process.stdin.isTTY && !options.all && !options.yes && !options.json && !options.empty) {
      const { checkNodeForCommand } = await import("./version/node-guard.js");
      const guard = checkNodeForCommand(command);
      if (!guard.ok) throw cliError("unsupported-node", guard.message!);
    }

    if (command !== "init") {
      const lock = readLockfile(options.targetRoot);
      if (!lock) throw cliError("no-lockfile", "No quiver.lock found. Run `quiver-cli init` first.");
      const input = options.positionals[0];
      if (input && ["remove", "update", "check", "enable", "disable"].includes(command)) {
        options.positionals[0] = resolveInstalledId(input, lock);
        if (["enable", "disable"].includes(command) && !options.positionals[0]!.startsWith("mcp:")) {
          throw cliError("usage", `${command} only supports MCP servers.`);
        }
      }
      if (command === "inspect") {
        const id = input!.startsWith("mcp:") ? input! : `mcp:${input}`;
        resolveInstalledId(id, lock);
      }
    }

    switch (command) {
      case "init": {
        const { init } = await import("./commands/init.js");
        await init(options);
        break;
      }
      case "add": {
        const { add } = await import("./commands/add.js");
        await add(options);
        break;
      }
      case "remove": {
        const { remove } = await import("./commands/remove.js");
        await remove(options);
        break;
      }
      case "enable":
      case "disable": {
        const { toggle } = await import("./commands/toggle.js");
        await toggle(options, command === "enable");
        break;
      }
      case "sync": {
        const { sync } = await import("./commands/sync.js");
        await sync(options);
        break;
      }
      case "providers": {
        const { providers } = await import("./commands/providers.js");
        await providers(options);
        break;
      }
      case "update": {
        const { update } = await import("./commands/update.js");
        await update(options);
        break;
      }
      case "list": {
        const { list } = await import("./commands/list.js");
        await list(options);
        break;
      }
      case "inspect": {
        const { inspect } = await import("./commands/inspect.js");
        await inspect(options);
        break;
      }
      case "check": {
        const { check } = await import("./commands/check.js");
        await check(options);
        break;
      }
      case "migrate": {
        const { migrate } = await import("./commands/migrate.js");
        await migrate(options);
        break;
      }
    }

    if (!process.exitCode && ["init", "add", "update"].includes(command) && !options.empty && !options.json && !options.dryRun) {
      await maybeNotifyUpdate(options.json);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = error && typeof error === "object" ? error as { code?: unknown; exitCode?: unknown } : {};
    const code = typeof detail.code === "string" ? detail.code : "command-failed";
    if (options?.json || argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, error: { code, message } }));
    } else {
      await ui.error(message);
    }
    process.exitCode = detail.exitCode === 1 ? 1 : 2;
  }
};

// Best-effort: never throws, never changes the command's exit code.
const maybeNotifyUpdate = async (json: boolean): Promise<void> => {
  try {
    const { checkForUpdate, notifierSuppressed, installHint } = await import(
      "./version/notifier.js"
    );
    if (notifierSuppressed(json)) return;
    const info = await checkForUpdate();
    if (!info.updateAvailable) return;
    const c = ui.palette();
    console.log(
      `\n${c.yellow("▲")} ${c.bold("update available")} ${c.dim(
        info.current,
      )} → ${c.cyan(info.latest!)}   ${c.dim(`run: ${installHint()}`)}`,
    );
  } catch {
    // Ignore notifier failures entirely.
  }
};

export const main = (): void => {
  void run();
};
