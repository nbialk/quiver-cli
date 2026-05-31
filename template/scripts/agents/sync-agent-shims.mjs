import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

// Load .env.local (if present) so env vars are available for interpolation
const envLocalPath = resolve(repoRoot, ".env.local");
if (existsSync(envLocalPath)) {
  for (const line of readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const sourcePath = resolve(repoRoot, ".agents/config.json");
const config = JSON.parse(readFileSync(sourcePath, "utf8"));
const checkMode = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Env-var interpolation: replaces "${VAR_NAME}" patterns with process.env
// ---------------------------------------------------------------------------

const interpolateEnvVars = (value) => {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        console.warn(
          `Warning: env var ${varName} is not set, skipping interpolation`,
        );
        return match;
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map(interpolateEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateEnvVars(v);
    }
    return result;
  }
  return value;
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const formatClaudeSettings = () =>
  JSON.stringify(config.claude.settings, null, 2) + "\n";

const formatMcpJson = () => {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return null;
  }
  const resolved = interpolateEnvVars(config.mcpServers);
  return JSON.stringify({ mcpServers: resolved }, null, 2) + "\n";
};

const formatOpenCodeJson = () => {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return null;
  }
  const resolved = interpolateEnvVars(config.mcpServers);
  const mcp = {};
  for (const [name, server] of Object.entries(resolved)) {
    if (server.transport === "http") {
      mcp[name] = { type: "remote", url: server.url };
      if (server.headers) {
        mcp[name].headers = server.headers;
      }
    } else if (server.transport === "stdio") {
      mcp[name] = {
        type: "local",
        command: [server.command, ...(server.args || [])],
      };
      if (server.env) {
        mcp[name].environment = server.env;
      }
    }
  }
  return (
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", mcp },
      null,
      2,
    ) + "\n"
  );
};

// ---------------------------------------------------------------------------
// File outputs (generated from config.json)
// ---------------------------------------------------------------------------

const mcpJsonContent = formatMcpJson();
const openCodeJsonContent = formatOpenCodeJson();

const fileOutputs = [
  {
    path: resolve(repoRoot, ".claude/settings.json"),
    content: formatClaudeSettings(),
  },
  ...(mcpJsonContent
    ? [{ path: resolve(repoRoot, ".mcp.json"), content: mcpJsonContent }]
    : []),
  ...(openCodeJsonContent
    ? [
        {
          path: resolve(repoRoot, "opencode.json"),
          content: openCodeJsonContent,
        },
      ]
    : []),
];

// ---------------------------------------------------------------------------
// Skills (.agents/skills/<name> -> .claude/skills/<name>)
// ---------------------------------------------------------------------------

const skillsRoot = resolve(repoRoot, ".agents/skills");

// Recursively discover every directory containing a SKILL.md, regardless of
// nesting depth (e.g. skills/design/audit/SKILL.md). The symlink shim is named
// after the leaf directory ("audit") so providers see a flat skills folder.
const discoverSkills = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const childDir = resolve(dir, entry.name);
    if (existsSync(resolve(childDir, "SKILL.md"))) {
      found.push({ name: entry.name, sourceDir: childDir });
    } else {
      found.push(...discoverSkills(childDir));
    }
  }
  return found;
};

const discoveredSkills = discoverSkills(skillsRoot).sort((left, right) =>
  left.name.localeCompare(right.name),
);

// Guard against two skills resolving to the same flat shim name.
const skillNameToSource = new Map();
for (const skill of discoveredSkills) {
  const existing = skillNameToSource.get(skill.name);
  if (existing && existing !== skill.sourceDir) {
    throw new Error(
      `Duplicate skill name "${skill.name}": ${existing} and ${skill.sourceDir}`,
    );
  }
  skillNameToSource.set(skill.name, skill.sourceDir);
}

const sharedSkillNames = discoveredSkills.map((skill) => skill.name);

// ---------------------------------------------------------------------------
// Commands (.agents/commands/<name>.md -> .claude/commands/ + .opencode/commands/)
// ---------------------------------------------------------------------------

const commandsRoot = resolve(repoRoot, ".agents/commands");
const sharedCommandNames = existsSync(commandsRoot)
  ? readdirSync(commandsRoot)
      .filter((name) => name.endsWith(".md"))
      .sort((left, right) => left.localeCompare(right))
  : [];

// ---------------------------------------------------------------------------
// Symlink outputs
// ---------------------------------------------------------------------------

const symlinkOutputs = [
  // Root discovery symlinks
  {
    path: resolve(repoRoot, "AGENTS.md"),
    target: resolve(repoRoot, ".agents/AGENTS.md"),
  },
  {
    path: resolve(repoRoot, "CLAUDE.md"),
    target: resolve(repoRoot, "AGENTS.md"),
  },
  // Skill symlinks for Claude
  ...discoveredSkills.map((skill) => ({
    path: resolve(repoRoot, ".claude/skills", skill.name),
    target: skill.sourceDir,
  })),
  // Skill symlinks for OpenCode
  ...discoveredSkills.map((skill) => ({
    path: resolve(repoRoot, ".opencode/skills", skill.name),
    target: skill.sourceDir,
  })),
  // Command symlinks for Claude
  ...sharedCommandNames.map((name) => ({
    path: resolve(repoRoot, ".claude/commands", name),
    target: resolve(commandsRoot, name),
  })),
  // Command symlinks for OpenCode
  ...sharedCommandNames.map((name) => ({
    path: resolve(repoRoot, ".opencode/commands", name),
    target: resolve(commandsRoot, name),
  })),
];

// ---------------------------------------------------------------------------
// Managed directories (stale entries get cleaned up)
// ---------------------------------------------------------------------------

const managedDirectoryEntries = [
  {
    path: resolve(repoRoot, ".claude/skills"),
    expectedChildren: new Set(sharedSkillNames),
  },
  {
    path: resolve(repoRoot, ".opencode/skills"),
    expectedChildren: new Set(sharedSkillNames),
  },
  {
    path: resolve(repoRoot, ".claude/commands"),
    expectedChildren: new Set(sharedCommandNames),
  },
  {
    path: resolve(repoRoot, ".opencode/commands"),
    expectedChildren: new Set(sharedCommandNames),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isMatchingSymlink = (path, target) => {
  const stats = lstatSync(path);
  if (!stats.isSymbolicLink()) {
    return false;
  }
  return resolve(dirname(path), readlinkSync(path)) === target;
};

const findUnexpectedChildren = ({ path, expectedChildren }) => {
  if (!existsSync(path)) {
    return [];
  }
  return readdirSync(path).filter((entry) => !expectedChildren.has(entry));
};

// Removes a path whether it is a real file/dir or a (possibly broken) symlink.
// rmSync with recursive:true follows symlinks and silently no-ops on broken
// ones (macOS), so symlinks must be unlinked directly via lstat.
const removePath = (path) => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    unlinkSync(path);
  } else {
    rmSync(path, { force: true, recursive: true });
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let hasMismatch = false;

// Process file outputs
for (const output of fileOutputs) {
  if (checkMode) {
    try {
      const current = readFileSync(output.path, "utf8");
      if (current !== output.content) {
        hasMismatch = true;
        console.error(`Out of sync: ${output.path}`);
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        hasMismatch = true;
        console.error(
          `Missing generated config: ${output.path}. Run "pnpm run agents:sync".`,
        );
        continue;
      }
      throw error;
    }
    continue;
  }

  mkdirSync(resolve(output.path, ".."), { recursive: true });
  writeFileSync(output.path, output.content);
  console.log(`Updated ${output.path}`);
}

// Process symlinks
for (const output of symlinkOutputs) {
  if (checkMode) {
    try {
      if (!isMatchingSymlink(output.path, output.target)) {
        hasMismatch = true;
        console.error(`Out of sync symlink: ${output.path}`);
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        hasMismatch = true;
        console.error(
          `Missing symlink shim: ${output.path}. Run "pnpm run agents:sync".`,
        );
        continue;
      }
      throw error;
    }
    continue;
  }

  mkdirSync(dirname(output.path), { recursive: true });

  try {
    if (isMatchingSymlink(output.path, output.target)) {
      continue;
    }
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  removePath(output.path);
  symlinkSync(
    relative(dirname(output.path), output.target),
    output.path,
    lstatSync(output.target).isDirectory() ? "dir" : "file",
  );
  console.log(`Linked ${output.path}`);
}

// Clean up stale entries in managed directories
for (const directory of managedDirectoryEntries) {
  const unexpectedChildren = findUnexpectedChildren(directory);

  if (unexpectedChildren.length === 0) {
    continue;
  }

  if (checkMode) {
    hasMismatch = true;
    for (const child of unexpectedChildren) {
      console.error(
        `Unexpected generated shim: ${resolve(directory.path, child)}`,
      );
    }
    continue;
  }

  for (const child of unexpectedChildren) {
    const childPath = resolve(directory.path, child);
    removePath(childPath);
    console.log(`Removed stale generated shim ${childPath}`);
  }
}

if (checkMode && hasMismatch) {
  process.exitCode = 1;
}
