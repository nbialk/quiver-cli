import process from "node:process";

import * as ui from "./ui/prompts.js";

export interface CliOptions {
  targetRoot: string;
  force: boolean;
  all: boolean;
  json: boolean;
  introspectStdio: boolean;
  positionals: string[];
}

const HELP = `quiver-cli - compose agent skills, commands & MCP servers into any repo

Usage:
  quiver-cli <command> [options]

Commands:
  init             Interactive picker over the catalog; write native configs + quiver.lock
  add <id>         Add a single catalog entry (skill:<name>, command:<name>, mcp:<name>)
  remove <id>      Remove a single entry; keep lockfile + configs consistent
  sync             Pull catalog state into the repo (additive, warns on drift)
  list             Show installed entries (skills, commands, MCP tool counts)
  status           Diff the lockfile against what is actually in the repo
  check            Detect upstream drift (skill digests, MCP tool snapshots)
  upstream         Check source repos for skill updates (catalog maintenance)
  help             Show this help
  version          Show the quiver-cli version

Options:
  -f, --force          Overwrite existing files
  --all, -y            Keep everything without prompting (non-interactive)
  --json               Machine-readable output (status/check/upstream)
  --introspect-stdio   Allow introspecting stdio MCP servers (runs foreign code)
  -v, --version        Show the quiver-cli version
`;

const parse = (argv: string[]): { command: string; options: CliOptions } => {
  const [command = "init", ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  const positionals = rest.filter((a) => !a.startsWith("-"));
  return {
    command,
    options: {
      targetRoot: process.cwd(),
      force: flags.has("--force") || flags.has("-f"),
      all: flags.has("--all") || flags.has("--yes") || flags.has("-y"),
      json: flags.has("--json"),
      introspectStdio: flags.has("--introspect-stdio"),
      positionals,
    },
  };
};

const run = async (): Promise<void> => {
  const { command, options } = parse(process.argv.slice(2));

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
    case "list":
    case "ls": {
      const { list } = await import("./commands/list.js");
      await list(options);
      break;
    }
    case "status": {
      const { status } = await import("./commands/status.js");
      await status(options);
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
    case "login": {
      const { login } = await import("./commands/login.js");
      await login(options);
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
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { packageRoot } = await import("./catalog/resolve.js");
      const pkg = JSON.parse(
        readFileSync(resolve(packageRoot, "package.json"), "utf8"),
      ) as { version: string };
      console.log(pkg.version);
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
};

run().catch(async (err) => {
  await ui.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
