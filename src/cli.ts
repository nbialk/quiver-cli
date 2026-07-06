import process from "node:process";

import * as ui from "./ui/prompts.js";

export interface CliOptions {
  targetRoot: string;
  force: boolean;
  all: boolean;
  json: boolean;
  verbose: boolean;
  accept: boolean;
  offline: boolean;
  introspectStdio: boolean;
  /** From --providers=a,b - validated by the consuming command. */
  providers: string[] | null;
  /** From --catalog=<source> - catalog source for init. */
  catalog: string | null;
  positionals: string[];
}

const HELP = `quiver-cli - compose agent skills, commands & MCP servers into any repo

Usage:
  quiver-cli <command> [options]

Commands:
  init             Interactive picker over the catalog; write native configs + quiver.lock
  add <id>         Add a single catalog entry (skill:<name>, command:<name>, mcp:<name>)
  remove <id>      Remove a single entry; keep lockfile + configs consistent
  sync             Regenerate provider configs from .agents/ (warns on drift)
  providers [a,b]  Change which tools get configs (claude, opencode, codex)
  update [id]      Pull newer catalog content into .agents/ (all or one entry)
  list             Show installed entries (skills, commands, MCP tool counts)
  check            Detect drift: skill digests, provider shims, MCP tool
                   snapshots (--offline skips MCP re-introspection)
  upstream         Catalog maintenance: check source repos for skill updates
                   (run in the quiver-cli repo or with a writable --catalog)
  upstream pull    Pull latest upstream content into the catalog [skill]
  help             Show this help
  version          Show the quiver-cli version

Options:
  -f, --force          Overwrite existing files
  --all, -y            Keep everything without prompting (non-interactive)
  --json               Machine-readable output (check/upstream/list)
  -V, --verbose        Show full tool lists and description diffs (check)
  --accept             Record the current MCP tool snapshots as the new baseline (check)
  --offline            Skip MCP re-introspection; check digests + shims only (check)
  --providers=a,b      Generate configs only for these tools (init, sync, providers)
  --catalog=<source>   Catalog source for init (e.g. github:owner/repo[/path][#ref])
  --introspect-stdio   Allow introspecting stdio MCP servers (runs foreign code)
  -v, --version        Show the quiver-cli version
`;

// Boolean flags (and their short aliases) the CLI understands.
const KNOWN_FLAGS = new Set([
  "--force",
  "-f",
  "--all",
  "--yes",
  "-y",
  "--json",
  "--verbose",
  "-V",
  "--accept",
  "--offline",
  "--introspect-stdio",
  "--help",
  "-h",
  "--version",
  "-v",
]);

// Flags that take an inline value, written as --name=value.
const KNOWN_VALUE_FLAGS = ["--providers", "--catalog"];

const isKnownFlag = (arg: string): boolean => {
  if (KNOWN_FLAGS.has(arg)) return true;
  return KNOWN_VALUE_FLAGS.some((f) => arg.startsWith(`${f}=`));
};

export const parse = (
  argv: string[],
): { command: string; options: CliOptions; unknownFlags: string[] } => {
  const [command = "init", ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const unknownFlags = [...flags].filter((a) => !isKnownFlag(a));

  const providersFlag = rest.find((a) => a.startsWith("--providers="));
  const providers = providersFlag
    ? providersFlag
        .slice("--providers=".length)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : null;

  const catalogFlag = rest.find((a) => a.startsWith("--catalog="));
  const catalog = catalogFlag
    ? catalogFlag.slice("--catalog=".length).trim() || null
    : null;

  return {
    command,
    unknownFlags,
    options: {
      targetRoot: process.cwd(),
      force: flags.has("--force") || flags.has("-f"),
      all: flags.has("--all") || flags.has("--yes") || flags.has("-y"),
      json: flags.has("--json"),
      verbose: flags.has("--verbose") || flags.has("-V"),
      accept: flags.has("--accept"),
      offline: flags.has("--offline"),
      introspectStdio: flags.has("--introspect-stdio"),
      providers,
      catalog,
      positionals,
    },
  };
};

export const run = async (): Promise<void> => {
  const { command, options, unknownFlags } = parse(process.argv.slice(2));

  if (unknownFlags.length) {
    await ui.error(
      `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.join(", ")}\n`,
    );
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  // Interactive pickers need clack (Node >= 20.12). Fail fast with an
  // actionable message instead of silently degrading to the numbered fallback.
  // Skip when running non-interactively (--all or no TTY): no prompts are shown.
  if (process.stdin.isTTY && !options.all) {
    const { checkNodeForCommand } = await import("./version/node-guard.js");
    const guard = checkNodeForCommand(command);
    if (!guard.ok) {
      await ui.error(guard.message!);
      process.exitCode = 1;
      return;
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
    case "remove":
    case "rm": {
      const { remove } = await import("./commands/remove.js");
      await remove(options);
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
    case "list":
    case "ls": {
      const { list } = await import("./commands/list.js");
      await list(options);
      break;
    }
    case "check": {
      const { check } = await import("./commands/check.js");
      await check(options);
      break;
    }
    case "upstream": {
      const { upstream } = await import("./commands/upstream.js");
      await upstream(options);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    case "version":
    case "--version":
    case "-v": {
      const { checkForUpdate, installHint } = await import(
        "./version/notifier.js"
      );
      const info = await checkForUpdate({ force: true });
      console.log(info.current);
      if (info.updateAvailable) {
        console.log(
          `update available: ${info.latest}  (run: ${installHint()})`,
        );
      }
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }

  // Passive update notice after the command's own output. `version` does its
  // own (forced) check; help/version need no nudge.
  if (!["version", "--version", "-v", "help", "--help", "-h"].includes(command)) {
    await maybeNotifyUpdate(options.json);
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
  run().catch(async (err) => {
    await ui.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
};
