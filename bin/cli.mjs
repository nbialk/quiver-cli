#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { install, templateRoot } from "../lib/install.mjs";

const args = process.argv.slice(2);
const command = args[0] || "init";
const flags = new Set(args.slice(1));
const force = flags.has("--force") || flags.has("-f");
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
  case "init":
    install(targetRoot, { force });
    runSync();
    break;
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
