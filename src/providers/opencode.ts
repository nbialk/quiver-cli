import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { McpServer } from "../catalog/discover.js";
import type { ProviderInputs, ProviderPlan } from "./claude.js";
import type { FileOutput, ManagedDir, SymlinkOutput } from "./fsops.js";

const formatOpenCodeJson = (
  servers: Record<string, McpServer>,
  overlay: Record<string, unknown> | null,
): string | null => {
  if (Object.keys(servers).length === 0 && !overlay) return null;
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "http") {
      mcp[name] = {
        type: "remote",
        url: preserveEnvReference(server.url),
        ...(server.headers
          ? { headers: preserveEnvReferences(server.headers) }
          : {}),
      };
    } else {
      mcp[name] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])].map(
          preserveEnvReference,
        ),
        ...(server.env
          ? { environment: preserveEnvReferences(server.env) }
          : {}),
      };
    }
  }
  const overlayMcp =
    overlay?.["mcp"] && typeof overlay["mcp"] === "object"
      ? (overlay["mcp"] as Record<string, unknown>)
      : {};
  const mergedMcp = { ...overlayMcp, ...mcp };
  const config = {
    ...overlay,
    $schema: "https://opencode.ai/config.json",
    ...(Object.keys(mergedMcp).length ? { mcp: mergedMcp } : {}),
  };
  return JSON.stringify(config, null, 2) + "\n";
};

const preserveEnvReference = (value: string): string =>
  value.replace(/\$\{([^}]+)\}/g, "{env:$1}");

const preserveEnvReferences = (
  values: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      preserveEnvReference(value),
    ]),
  );

export const planOpenCode = (inputs: ProviderInputs): ProviderPlan => {
  const {
    targetRoot,
    selected,
    rawMcpServers,
    opencodeConfig,
    tuiConfig,
  } = inputs;
  const files: FileOutput[] = [];
  const removeFiles: string[] = [];

  const json = formatOpenCodeJson(rawMcpServers, opencodeConfig);
  const jsonPath = resolve(targetRoot, "opencode.json");
  if (json) files.push({ path: jsonPath, content: json });
  else removeFiles.push(jsonPath);

  const tuiPath = resolve(targetRoot, ".opencode/tui.json");
  const tuiMarkerPath = resolve(targetRoot, ".opencode/.quiver-tui");
  if (tuiConfig) {
    files.push({
      path: tuiPath,
      content:
        JSON.stringify(
          { ...tuiConfig, $schema: "https://opencode.ai/tui.json" },
          null,
          2,
        ) + "\n",
    });
    files.push({ path: tuiMarkerPath, content: "managed by quiver\n" });
  } else if (existsSync(tuiMarkerPath)) {
    removeFiles.push(tuiPath, tuiMarkerPath);
  }

  const symlinks: SymlinkOutput[] = [
    ...selected.skills.map((s) => ({
      path: resolve(targetRoot, ".opencode/skills", s.name),
      target: s.absDir,
    })),
    ...selected.commands.map((c) => ({
      path: resolve(targetRoot, ".opencode/commands", `${c.name}.md`),
      target: c.absPath,
    })),
    ...selected.plugins.map((plugin) => ({
      path: resolve(
        targetRoot,
        ".opencode/plugins",
        `${plugin.name}${plugin.absPath.endsWith(".js") ? ".js" : ".ts"}`,
      ),
      target: plugin.absPath,
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
    {
      path: resolve(targetRoot, ".opencode/plugins"),
      expected: new Set(
        selected.plugins.map(
          (plugin) =>
            `${plugin.name}${plugin.absPath.endsWith(".js") ? ".js" : ".ts"}`,
        ),
      ),
    },
  ];

  return { files, removeFiles, symlinks, managedDirs };
};
