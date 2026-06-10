import { describe, expect, it } from "vitest";

import { planCodex } from "../src/providers/codex.js";
import type { ProviderInputs } from "../src/providers/claude.js";
import type { McpServer } from "../src/catalog/discover.js";

const baseInputs = (
  rawMcpServers: Record<string, McpServer>,
): ProviderInputs => ({
  targetRoot: "/tmp/x",
  agentsRoot: "/tmp/x/.agents",
  selected: { skills: [], commands: [], mcp: [] },
  mcpServers: {},
  rawMcpServers,
  claudeSettings: null,
});

describe("planCodex", () => {
  it("maps ${VAR} headers to env_http_headers and keeps static ones", () => {
    const plan = planCodex(
      baseInputs({
        neon: {
          transport: "http",
          url: "https://mcp.neon.tech/mcp",
          headers: {
            Authorization: "Bearer ${NEON_API_KEY}",
            "X-Static": "literal",
          },
        },
      }),
    );
    const toml = plan.files[0]!.content;
    expect(toml).toContain("[mcp_servers.neon.env_http_headers]");
    expect(toml).toContain('Authorization = "NEON_API_KEY"');
    expect(toml).toContain('X-Static = "literal"');
  });

  it("emits stdio servers with command/args and no shims", () => {
    const plan = planCodex(
      baseInputs({
        playwright: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
        },
      }),
    );
    expect(plan.files[0]!.content).toContain("[mcp_servers.playwright]");
    expect(plan.symlinks).toHaveLength(0);
    expect(plan.managedDirs).toHaveLength(0);
  });

  it("schedules removal of config.toml when no servers", () => {
    const plan = planCodex(baseInputs({}));
    expect(plan.files).toHaveLength(0);
    expect(plan.removeFiles).toHaveLength(1);
    expect(plan.removeFiles[0]).toContain(".codex/config.toml");
  });
});
