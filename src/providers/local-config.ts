import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Per-machine overrides for the committed .agents/config.json. Written by
// `quiver-cli enable/disable` and gitignored - toggling an MCP server on or
// off never produces a diff in the shared catalog.
export interface LocalMcpOverride {
  enabled?: boolean;
}

export interface LocalConfig {
  mcpServers?: Record<string, LocalMcpOverride>;
}

export const localConfigPath = (targetRoot: string): string =>
  resolve(targetRoot, ".agents", "config.local.json");

export const readLocalConfig = (targetRoot: string): LocalConfig => {
  const path = localConfigPath(targetRoot);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as LocalConfig;
};

// Names of MCP servers disabled on this machine (enabled: false).
export const disabledMcpServers = (targetRoot: string): Set<string> => {
  const disabled = new Set<string>();
  const servers = readLocalConfig(targetRoot).mcpServers ?? {};
  for (const [name, override] of Object.entries(servers)) {
    if (override.enabled === false) disabled.add(name);
  }
  return disabled;
};

// Flip a server's local enabled state. Enabling removes the override (enabled
// is the default); an empty override file is deleted entirely.
export const setMcpEnabled = (
  targetRoot: string,
  name: string,
  enabled: boolean,
): void => {
  const config = readLocalConfig(targetRoot);
  const servers = { ...(config.mcpServers ?? {}) };
  if (enabled) delete servers[name];
  else servers[name] = { enabled: false };

  if (Object.keys(servers).length) config.mcpServers = servers;
  else delete config.mcpServers;

  const path = localConfigPath(targetRoot);
  if (Object.keys(config).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
};
