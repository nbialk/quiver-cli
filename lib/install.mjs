import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import * as ui from "./ui.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(packageRoot, "template");

// Generated provider files that should never be committed in a target repo.
const GITIGNORE_ENTRIES = [
  "# Generated agent provider files (source of truth is .agents/)",
  ".claude/",
  ".opencode/",
  ".mcp.json",
  "opencode.json",
  "tui.json",
];

const PACKAGE_SCRIPTS = {
  "agents:sync": "node scripts/agents/sync-agent-shims.mjs",
  "agents:check": "node scripts/agents/sync-agent-shims.mjs --check",
};

const POSTINSTALL_CMD = "node scripts/agents/sync-agent-shims.mjs";

const log = (msg) => console.log(msg);

const copyTemplate = async (targetRoot, { force }) => {
  const targets = [
    { rel: ".agents", label: "agent config" },
    { rel: "scripts/agents", label: "sync script" },
  ];

  const copied = [];
  const skipped = [];
  for (const { rel } of targets) {
    const src = resolve(templateRoot, rel);
    const dest = resolve(targetRoot, rel);
    if (existsSync(dest) && !force) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    copied.push(rel);
  }

  if (copied.length) {
    await ui.step(`Copied ${copied.join(", ")}`);
  }
  if (skipped.length) {
    await ui.info(`Kept existing ${skipped.join(", ")} (use --force to overwrite)`);
  }
};

const patchPackageJson = async (targetRoot) => {
  const pkgPath = resolve(targetRoot, "package.json");
  if (!existsSync(pkgPath)) {
    await ui.warn(
      "No package.json found - add agents:sync/agents:check scripts manually.",
    );
    return;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts = pkg.scripts || {};
  let changed = false;

  for (const [name, cmd] of Object.entries(PACKAGE_SCRIPTS)) {
    if (pkg.scripts[name] !== cmd) {
      pkg.scripts[name] = cmd;
      changed = true;
    }
  }

  // Append sync to postinstall (idempotent).
  const existing = pkg.scripts.postinstall;
  if (!existing) {
    pkg.scripts.postinstall = POSTINSTALL_CMD;
    changed = true;
  } else if (!existing.includes("sync-agent-shims.mjs")) {
    pkg.scripts.postinstall = `${existing} && ${POSTINSTALL_CMD}`;
    changed = true;
  }

  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    await ui.step("Wired package.json scripts (agents:sync, agents:check, postinstall)");
  }
};

const patchGitignore = async (targetRoot) => {
  const gitignorePath = resolve(targetRoot, ".gitignore");
  const current = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";

  const missing = GITIGNORE_ENTRIES.filter(
    (entry) => entry.startsWith("#") || !current.includes(entry),
  );

  // If every non-comment entry is already present, do nothing.
  const realMissing = missing.filter((entry) => !entry.startsWith("#"));
  if (realMissing.length === 0) {
    return;
  }

  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const block = (current ? "\n" : "") + GITIGNORE_ENTRIES.join("\n") + "\n";
  writeFileSync(gitignorePath, current + prefix + block);
  await ui.step("Updated .gitignore with generated paths");
};

// Human-readable detail for a server entry (URL for http, command for stdio).
const serverDetail = (server) =>
  server.transport === "http"
    ? server.url
    : [server.command, ...(server.args || [])].filter(Boolean).join(" ");

const prompt = (question) =>
  new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer);
    });
  });

// Parses an answer like "1,3,5" or "all" / "none" into a Set of selected keys.
const parseSelection = (answer, keys) => {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all" || trimmed === "a") {
    return new Set(keys);
  }
  if (trimmed === "none" || trimmed === "n") {
    return new Set();
  }
  const selected = new Set();
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const index = Number.parseInt(token, 10);
    if (Number.isInteger(index) && index >= 1 && index <= keys.length) {
      selected.add(keys[index - 1]);
    }
  }
  return selected;
};

// Modern checkbox UI via @clack/prompts (arrow keys, space to toggle, "a" for
// all). Returns an array of selected keys, or null if clack is unavailable so
// the caller can fall back to the plain text prompt.
const selectWithClack = async (servers, keys) => {
  const clack = await ui.loadClack();
  if (!clack) {
    return null;
  }

  const selected = await clack.multiselect({
    message: "Select MCP servers to install (space to toggle, a for all)",
    options: keys.map((key) => ({
      value: key,
      label: key,
      hint: serverDetail(servers[key]),
    })),
    initialValues: keys,
    required: false,
  });

  if (clack.isCancel(selected)) {
    clack.cancel("Cancelled - keeping config.json unchanged.");
    process.exit(0);
  }

  return selected;
};

// Plain readline fallback: lists servers and accepts numbers / "all" / "none".
const selectWithText = async (servers, keys) => {
  log("\nSelect MCP servers to install:");
  keys.forEach((key, index) => {
    log(`  ${index + 1}) ${key}  (${serverDetail(servers[key])})`);
  });
  const answer = await prompt(
    "\nEnter numbers (comma-separated), 'all', or 'none' [all]: ",
  );
  return [...parseSelection(answer, keys)];
};

// Interactively prompt which MCP servers to keep, then rewrite config.json in
// the target repo to retain only the selected ones. No-op when there are no
// servers, when stdin is not a TTY, or when a non-interactive mode is forced.
export const selectMcpServers = async (
  targetRoot,
  { interactive = true } = {},
) => {
  const configPath = resolve(targetRoot, ".agents/config.json");
  if (!existsSync(configPath)) {
    return;
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const servers = config.mcpServers || {};
  const keys = Object.keys(servers);
  if (keys.length === 0) {
    return;
  }

  if (!interactive || !process.stdin.isTTY) {
    await ui.info(`Keeping all ${keys.length} MCP servers (non-interactive)`);
    return;
  }

  const selectedKeys =
    (await selectWithClack(servers, keys)) ??
    (await selectWithText(servers, keys));
  const selected = new Set(selectedKeys);

  const kept = {};
  for (const key of keys) {
    if (selected.has(key)) {
      kept[key] = servers[key];
    }
  }

  if (Object.keys(kept).length === keys.length) {
    await ui.success(`All ${keys.length} MCP servers selected`);
    return;
  }

  config.mcpServers = kept;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const keptNames = Object.keys(kept);
  await ui.success(
    `MCP servers: ${keptNames.length ? keptNames.join(", ") : "none"}`,
  );
};

export const install = async (targetRoot, { force = false } = {}) => {
  await copyTemplate(targetRoot, { force });
  await patchPackageJson(targetRoot);
  await patchGitignore(targetRoot);
};

export { templateRoot, packageRoot };
