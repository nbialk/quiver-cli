import { resolve } from "node:path";

import type { McpServer } from "../catalog/discover.js";
import type { SelectedArtifacts } from "./selection.js";
import type { FileOutput, ManagedDir, SymlinkOutput } from "./fsops.js";

export interface ProviderInputs {
  targetRoot: string;
  agentsRoot: string;
  selected: SelectedArtifacts;
  /** Already env-interpolated MCP servers, keyed by name (Claude/opencode). */
  mcpServers: Record<string, McpServer>;
  /** Raw MCP servers with ${VAR} placeholders intact (Codex env mapping). */
  rawMcpServers: Record<string, McpServer>;
  claudeSettings: unknown;
}

export interface ProviderPlan {
  files: FileOutput[];
  removeFiles: string[];
  symlinks: SymlinkOutput[];
  managedDirs: ManagedDir[];
}

const formatMcpJson = (servers: Record<string, McpServer>): string | null => {
  if (Object.keys(servers).length === 0) return null;
  return JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
};

export const planClaude = (inputs: ProviderInputs): ProviderPlan => {
  const { targetRoot, selected, mcpServers, claudeSettings } = inputs;
  const files: FileOutput[] = [];
  const removeFiles: string[] = [];

  if (claudeSettings) {
    files.push({
      path: resolve(targetRoot, ".claude/settings.json"),
      content: JSON.stringify(claudeSettings, null, 2) + "\n",
    });
  }

  const mcp = formatMcpJson(mcpServers);
  const mcpPath = resolve(targetRoot, ".mcp.json");
  if (mcp) files.push({ path: mcpPath, content: mcp });
  else removeFiles.push(mcpPath);

  const skillNames = selected.skills.map((s) => s.name);
  const commandFiles = selected.commands.map((c) => `${c.name}.md`);

  const symlinks: SymlinkOutput[] = [
    ...selected.skills.map((s) => ({
      path: resolve(targetRoot, ".claude/skills", s.name),
      target: s.absDir,
    })),
    ...selected.commands.map((c) => ({
      path: resolve(targetRoot, ".claude/commands", `${c.name}.md`),
      target: c.absPath,
    })),
  ];

  const managedDirs: ManagedDir[] = [
    {
      path: resolve(targetRoot, ".claude/skills"),
      expected: new Set(skillNames),
    },
    {
      path: resolve(targetRoot, ".claude/commands"),
      expected: new Set(commandFiles),
    },
  ];

  return { files, removeFiles, symlinks, managedDirs };
};
