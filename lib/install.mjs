import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  "# Local secrets for MCP env-var interpolation",
  ".env.local",
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

  // Surface the secrets template at the repo root next to where the user's
  // .env.local should live. Never clobber an existing one.
  const exampleSrc = resolve(templateRoot, ".agents/.env.local.example");
  const exampleDest = resolve(targetRoot, ".env.local.example");
  if (existsSync(exampleSrc) && (!existsSync(exampleDest) || force)) {
    cpSync(exampleSrc, exampleDest, { force: true });
    copied.push(".env.local.example");
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

// ---------------------------------------------------------------------------
// Grouped selection (shared by MCP servers and skills)
// ---------------------------------------------------------------------------
//
// `groups` is an ordered array of { name, items }, where each item is
// { value, label, hint }. Returns an array of selected values, or null if
// clack is unavailable so the caller can fall back to the text prompt.

const selectGroupedWithClack = async ({ message, groups, initialValues }) => {
  const clack = await ui.loadClack();
  if (!clack) {
    return null;
  }

  // clack groupMultiselect takes { [groupName]: items[] } with group order
  // preserved by insertion order.
  const options = {};
  for (const group of groups) {
    options[`(${group.name})`] = group.items;
  }

  const selected = await clack.groupMultiselect({
    message,
    options,
    initialValues,
    required: false,
    selectableGroups: false,
  });

  if (clack.isCancel(selected)) {
    clack.cancel("Cancelled - no changes made.");
    process.exit(0);
  }

  return selected;
};

// Plain readline fallback: flat numbered list grouped by header lines.
const selectGroupedWithText = async ({ label, groups, initialValues }) => {
  const flat = groups.flatMap((g) => g.items.map((i) => i.value));
  log(`\nSelect ${label}:`);
  let index = 0;
  for (const group of groups) {
    log(`  (${group.name})`);
    for (const item of group.items) {
      index += 1;
      const mark = initialValues.includes(item.value) ? "*" : " ";
      const hint = item.hint ? `  (${item.hint})` : "";
      log(`    ${index}) [${mark}] ${item.label}${hint}`);
    }
  }
  const preselected = flat
    .map((v, i) => (initialValues.includes(v) ? i + 1 : null))
    .filter(Boolean)
    .join(",");
  const answer = await prompt(
    `\nEnter numbers (comma-separated), 'all', or 'none' [${preselected || "none"}]: `,
  );
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "all" || trimmed === "a") return flat;
  if (trimmed === "none" || trimmed === "n") return [];
  if (trimmed === "") return flat.filter((v) => initialValues.includes(v));
  const picked = new Set();
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const n = Number.parseInt(token, 10);
    if (Number.isInteger(n) && n >= 1 && n <= flat.length) picked.add(flat[n - 1]);
  }
  return [...picked];
};

// ---------------------------------------------------------------------------
// MCP server selection
// ---------------------------------------------------------------------------

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

  // Group by transport: remote (http) first, then local (stdio).
  const remote = keys.filter((k) => servers[k].transport === "http");
  const local = keys.filter((k) => servers[k].transport !== "http");
  const groups = [
    { name: "remote", items: remote },
    { name: "local", items: local },
  ]
    .filter((g) => g.items.length)
    .map((g) => ({
      name: g.name,
      items: g.items.map((key) => ({
        value: key,
        label: key,
        hint: serverDetail(servers[key]),
      })),
    }));

  const selectedKeys =
    (await selectGroupedWithClack({
      message: "Select MCP servers (space toggles, a all, enter confirms)",
      groups,
      initialValues: [],
    })) ??
    (await selectGroupedWithText({
      label: "MCP servers",
      groups,
      initialValues: [],
    }));
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

// ---------------------------------------------------------------------------
// Command selection
// ---------------------------------------------------------------------------

// Commands preselected by default.
const DEFAULT_COMMANDS = ["cp"];

// Interactively prompt which slash commands to keep, then delete the deselected
// command files. No-op when there are no commands, when stdin is not a TTY, or
// when non-interactive.
export const selectCommands = async (targetRoot, { interactive = true } = {}) => {
  const commandsRoot = resolve(targetRoot, ".agents/commands");
  if (!existsSync(commandsRoot)) {
    return;
  }

  const files = readdirSync(commandsRoot).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    return;
  }

  // name without extension (e.g. "cp" from "cp.md")
  const names = files.map((f) => f.replace(/\.md$/, "")).sort();

  if (!interactive || !process.stdin.isTTY) {
    await ui.info(`Keeping all ${names.length} commands (non-interactive)`);
    return;
  }

  const groups = [
    {
      name: "commands",
      items: names.map((name) => ({ value: name, label: `/${name}` })),
    },
  ];
  const initialValues = names.filter((n) => DEFAULT_COMMANDS.includes(n));

  const selectedNames =
    (await selectGroupedWithClack({
      message: "Select commands to install (space toggles, a all, enter confirms)",
      groups,
      initialValues,
    })) ??
    (await selectGroupedWithText({
      label: "commands",
      groups,
      initialValues,
    }));
  const selected = new Set(selectedNames);

  if (selected.size === names.length) {
    await ui.success(`All ${names.length} commands selected`);
    return;
  }

  for (const name of names) {
    if (!selected.has(name)) {
      rmSync(resolve(commandsRoot, `${name}.md`), { force: true });
    }
  }

  await ui.success(
    `Commands: ${selected.size ? [...selected].map((n) => `/${n}`).join(", ") : "none"}`,
  );
};

// ---------------------------------------------------------------------------
// Skill selection
// ---------------------------------------------------------------------------

// Skills preselected by default (the meta skills always worth keeping).
const DEFAULT_SKILLS = ["find-skills", "skill-creator"];

// Discover skills under .agents/skills as { name, dir, group }. Top-level
// skills (no parent subfolder) are grouped as "general"; nested skills use
// their immediate parent folder name (design, code, repo, ...).
const discoverSkills = (skillsRoot) => {
  const found = [];
  const walk = (dir, group) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childDir = resolve(dir, entry.name);
      if (existsSync(resolve(childDir, "SKILL.md"))) {
        found.push({ name: entry.name, dir: childDir, group: group ?? "general" });
      } else {
        walk(childDir, group ?? entry.name);
      }
    }
  };
  walk(skillsRoot, null);
  return found;
};

// Interactively prompt which skills to keep, then delete the deselected skill
// directories (and any group folders left empty). No-op when there are no
// skills, when stdin is not a TTY, or when non-interactive.
export const selectSkills = async (targetRoot, { interactive = true } = {}) => {
  const skillsRoot = resolve(targetRoot, ".agents/skills");
  if (!existsSync(skillsRoot)) {
    return;
  }

  const skills = discoverSkills(skillsRoot);
  if (skills.length === 0) {
    return;
  }

  if (!interactive || !process.stdin.isTTY) {
    await ui.info(`Keeping all ${skills.length} skills (non-interactive)`);
    return;
  }

  // Order groups: general first, then the rest alphabetically.
  const groupNames = [...new Set(skills.map((s) => s.group))].sort((a, b) => {
    if (a === "general") return -1;
    if (b === "general") return 1;
    return a.localeCompare(b);
  });

  // Within general, surface DEFAULT_SKILLS first.
  const orderItems = (items, group) => {
    if (group !== "general") return items.sort((a, b) => a.name.localeCompare(b.name));
    return items.sort((a, b) => {
      const ad = DEFAULT_SKILLS.includes(a.name);
      const bd = DEFAULT_SKILLS.includes(b.name);
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  };

  const groups = groupNames.map((name) => ({
    name,
    items: orderItems(
      skills.filter((s) => s.group === name),
      name,
    ).map((s) => ({ value: s.name, label: s.name })),
  }));

  const initialValues = skills
    .map((s) => s.name)
    .filter((name) => DEFAULT_SKILLS.includes(name));

  const selectedNames =
    (await selectGroupedWithClack({
      message: "Select skills to install (space toggles, a all, enter confirms)",
      groups,
      initialValues,
    })) ??
    (await selectGroupedWithText({
      label: "skills",
      groups,
      initialValues,
    }));
  const selected = new Set(selectedNames);

  if (selected.size === skills.length) {
    await ui.success(`All ${skills.length} skills selected`);
    return;
  }

  // Delete deselected skill directories.
  for (const skill of skills) {
    if (!selected.has(skill.name)) {
      rmSync(skill.dir, { recursive: true, force: true });
    }
  }

  // Remove now-empty group folders.
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const groupDir = resolve(skillsRoot, entry.name);
    if (existsSync(resolve(groupDir, "SKILL.md"))) continue; // it's a skill, keep
    if (readdirSync(groupDir).length === 0) {
      rmSync(groupDir, { recursive: true, force: true });
    }
  }

  await ui.success(
    `Skills: ${selected.size ? [...selected].join(", ") : "none"}`,
  );
};

export const install = async (targetRoot, { force = false } = {}) => {
  await copyTemplate(targetRoot, { force });
  await patchPackageJson(targetRoot);
  await patchGitignore(targetRoot);
};

export { templateRoot, packageRoot };
