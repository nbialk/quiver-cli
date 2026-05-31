import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const copyTemplate = (targetRoot, { force }) => {
  const targets = [
    { rel: ".agents", label: "agent config" },
    { rel: "scripts/agents", label: "sync script" },
  ];

  for (const { rel, label } of targets) {
    const src = resolve(templateRoot, rel);
    const dest = resolve(targetRoot, rel);
    if (existsSync(dest) && !force) {
      log(`Skipped ${rel} (already exists, use --force to overwrite) [${label}]`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    log(`Copied ${rel} (${label})`);
  }
};

const patchPackageJson = (targetRoot) => {
  const pkgPath = resolve(targetRoot, "package.json");
  if (!existsSync(pkgPath)) {
    log(
      "No package.json found - skipped script wiring. Add agents:sync/agents:check manually.",
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
    log("Patched package.json scripts (agents:sync, agents:check, postinstall)");
  } else {
    log("package.json scripts already up to date");
  }
};

const patchGitignore = (targetRoot) => {
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
    log(".gitignore already covers generated files");
    return;
  }

  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const block = (current ? "\n" : "") + GITIGNORE_ENTRIES.join("\n") + "\n";
  writeFileSync(gitignorePath, current + prefix + block);
  log("Updated .gitignore with generated agent paths");
};

export const install = (targetRoot, { force = false } = {}) => {
  log(`Installing agents into ${targetRoot}`);
  copyTemplate(targetRoot, { force });
  patchPackageJson(targetRoot);
  patchGitignore(targetRoot);
};

export { templateRoot, packageRoot };
