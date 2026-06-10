import { resolve } from "node:path";

import type { McpServer } from "../catalog/discover.js";
import type { ProviderInputs, ProviderPlan } from "./claude.js";
import type { FileOutput, ManagedDir, SymlinkOutput } from "./fsops.js";

const formatOpenCodeJson = (
  servers: Record<string, McpServer>,
): string | null => {
  if (Object.keys(servers).length === 0) return null;
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "http") {
      mcp[name] = {
        type: "remote",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    } else {
      mcp[name] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        ...(server.env ? { environment: server.env } : {}),
      };
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

export const planOpenCode = (inputs: ProviderInputs): ProviderPlan => {
  const { targetRoot, selected, mcpServers } = inputs;
  const files: FileOutput[] = [];
  const removeFiles: string[] = [];

  const json = formatOpenCodeJson(mcpServers);
  const jsonPath = resolve(targetRoot, "opencode.json");
  if (json) files.push({ path: jsonPath, content: json });
  else removeFiles.push(jsonPath);

  const symlinks: SymlinkOutput[] = [
    ...selected.skills.map((s) => ({
      path: resolve(targetRoot, ".opencode/skills", s.name),
      target: s.absDir,
    })),
    ...selected.commands.map((c) => ({
      path: resolve(targetRoot, ".opencode/commands", `${c.name}.md`),
      target: c.absPath,
    })),
  ];

  const managedDirs: ManagedDir[] = [
    {
      path: resolve(targetRoot, ".opencode/skills"),
      expected: new Set(selected.skills.map((s) => s.name)),
    },
    {
      path: resolve(targetRoot, ".opencode/commands"),
      expected: new Set(selected.commands.map((c) => `${c.name}.md`)),
    },
  ];

  return { files, removeFiles, symlinks, managedDirs };
};
