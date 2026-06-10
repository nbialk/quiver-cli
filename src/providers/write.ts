import { existsSync, lstatSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { Catalog, McpServer } from "../catalog/discover.js";
import type { Lockfile } from "../lockfile/schema.js";
import { interpolateEnvVars, loadEnvLocal } from "../secrets/interpolate.js";
import type { ProviderInputs } from "./claude.js";
import { planClaude } from "./claude.js";
import { planCodex } from "./codex.js";
import {
  applyOutputs,
  checkOutputs,
  type ApplyResult,
  type FileOutput,
  type ManagedDir,
  type SymlinkOutput,
} from "./fsops.js";
import { planOpenCode } from "./opencode.js";
import { resolveSelection } from "./selection.js";

export type { ApplyResult as WriteResult };

// A root path is safe to (re)link only when it is absent or already a symlink.
// Real files/dirs are user content and must never be replaced.
const isLinkable = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true; // ENOENT - path is free
  }
};

const buildPlan = (
  targetRoot: string,
  catalog: Catalog,
  lock: Lockfile,
  onMissingEnv: (name: string) => void,
  onSkippedRootFile?: (name: string) => void,
): {
  files: FileOutput[];
  removeFiles: string[];
  symlinks: SymlinkOutput[];
  managedDirs: ManagedDir[];
} => {
  loadEnvLocal(targetRoot);
  const selected = resolveSelection(catalog, lock);

  // Only include MCP servers that are actually selected in the lockfile.
  const rawMcpServers: Record<string, McpServer> = {};
  for (const mcp of selected.mcp) rawMcpServers[mcp.name] = mcp.server;
  const mcpServers = interpolateEnvVars(rawMcpServers, onMissingEnv);

  const agentsRoot = resolve(targetRoot, ".agents");
  const inputs: ProviderInputs = {
    targetRoot,
    agentsRoot,
    selected,
    mcpServers,
    rawMcpServers,
    claudeSettings: catalog.config.claude?.settings ?? null,
  };

  const plans = [planClaude(inputs), planOpenCode(inputs), planCodex(inputs)];

  // Root discovery symlinks (AGENTS.md, CLAUDE.md) when the catalog ships
  // them. Existing real files are user content: skip and report, never replace.
  const rootSymlinks: SymlinkOutput[] = [];
  const agentsMd = resolve(agentsRoot, "AGENTS.md");
  if (existsSync(agentsMd)) {
    const rootAgents = resolve(targetRoot, "AGENTS.md");
    for (const link of [
      { path: rootAgents, target: agentsMd },
      { path: resolve(targetRoot, "CLAUDE.md"), target: rootAgents },
    ]) {
      if (isLinkable(link.path)) rootSymlinks.push(link);
      else onSkippedRootFile?.(basename(link.path));
    }
  }

  return {
    files: plans.flatMap((p) => p.files),
    removeFiles: plans.flatMap((p) => p.removeFiles),
    symlinks: [...rootSymlinks, ...plans.flatMap((p) => p.symlinks)],
    managedDirs: plans.flatMap((p) => p.managedDirs),
  };
};

export const writeProviders = (
  targetRoot: string,
  catalog: Catalog,
  lock: Lockfile,
): ApplyResult => {
  const missing = new Set<string>();
  const skipped = new Set<string>();
  const plan = buildPlan(
    targetRoot,
    catalog,
    lock,
    (n) => missing.add(n),
    (n) => skipped.add(n),
  );
  const result = applyOutputs(plan);
  if (missing.size) {
    console.warn(
      `Warning: unset env vars left un-interpolated: ${[...missing].join(", ")}. ` +
        `Set them in .env.local and re-run quiver-cli sync.`,
    );
  }
  if (skipped.size) {
    console.warn(
      `Warning: ${[...skipped].join(", ")} already exist(s) and is not managed by quiver - ` +
        `left untouched. Merge .agents/AGENTS.md manually if desired.`,
    );
  }
  return result;
};

// Returns a list of human-readable mismatches (empty = in sync).
export const checkProviders = (
  targetRoot: string,
  catalog: Catalog,
  lock: Lockfile,
): string[] => {
  const plan = buildPlan(targetRoot, catalog, lock, () => {});
  return checkOutputs(plan);
};
