#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import {
  install,
  selectCommands,
  selectMcpServers,
  selectSkills,
  templateRoot,
} from "../lib/install.mjs";
import * as ui from "../lib/ui.mjs";

const args = process.argv.slice(2);
const command = args[0] || "init";
const flags = new Set(args.slice(1));
const force = flags.has("--force") || flags.has("-f");
const skipPrompts =
  flags.has("--all") ||
  flags.has("--all-mcp") ||
  flags.has("--yes") ||
  flags.has("-y");
const targetRoot = process.cwd();

const HELP = `nb-agents - portable AI agent config (.agents/ skills & commands)

Usage:
  npx nb-agents <command> [options]

Commands:
  init      Copy .agents/ + sync script, wire package.json & .gitignore, then sync
  sync      Regenerate provider shims in the current repo
  check     Verify provider shims are up to date (exit 1 if not)
  update    Re-copy .agents/ and the sync script only (no package.json/.gitignore changes)
  help      Show this help

Options:
  -f, --force   Overwrite existing files (init/update)
  --all, -y     Keep all skills and MCP servers without prompting (init)
`;

const SYNC_SCRIPT_REL = "scripts/agents/sync-agent-shims.mjs";

const runSync = (extraArgs = []) => {
  const scriptPath = resolve(targetRoot, SYNC_SCRIPT_REL);
  if (!existsSync(scriptPath)) {
    console.error(
      `Missing ${SYNC_SCRIPT_REL}. Run "npx nb-agents init" first.`,
    );
    process.exit(1);
  }
  const result = spawnSync("node", [scriptPath, ...extraArgs], {
    cwd: targetRoot,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
};

// Quiet sync used during `init`: captures the compact summary and surfaces it
// through a spinner instead of streaming dozens of per-file lines.
const runSyncQuiet = async () => {
  const scriptPath = resolve(targetRoot, SYNC_SCRIPT_REL);
  if (!existsSync(scriptPath)) {
    await ui.error(`Missing ${SYNC_SCRIPT_REL}. Run "npx nb-agents init" first.`);
    return 1;
  }
  const s = await ui.spinner();
  s.start("Generating provider shims");
  const result = spawnSync("node", [scriptPath, "--quiet"], {
    cwd: targetRoot,
    encoding: "utf8",
  });
  const summary =
    (result.stdout || "").trim().split("\n").filter(Boolean).pop() || "done";
  if (result.status === 0) {
    s.stop(`Provider shims ready (${summary})`);
  } else {
    s.stop("Sync failed");
    if (result.stderr) await ui.error(result.stderr.trim());
  }
  return result.status ?? 1;
};

const copyOnly = () => {
  for (const rel of [".agents", "scripts/agents"]) {
    const src = resolve(templateRoot, rel);
    const dest = resolve(targetRoot, rel);
    if (existsSync(dest) && !force) {
      console.log(`Skipped ${rel} (exists, use --force)`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    console.log(`Updated ${rel}`);
  }
};

switch (command) {
  case "init": {
    await ui.intro("nb-agents");
    await install(targetRoot, { force });
    await selectSkills(targetRoot, { interactive: !skipPrompts });
    await selectCommands(targetRoot, { interactive: !skipPrompts });
    await selectMcpServers(targetRoot, { interactive: !skipPrompts });
    const status = await runSyncQuiet();
    if (status === 0) {
      await ui.outro("Done. Restart your AI tool to load the new config.");
    }
    process.exit(status);
  }
  case "sync":
    runSync();
    break;
  case "check":
    runSync(["--check"]);
    break;
  case "update":
    copyOnly();
    runSync();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(1);
}
