import { describe, expect, it } from "vitest";

import type { CatalogPlugin, McpServer } from "../src/catalog/discover.js";
import type { ProviderInputs } from "../src/providers/claude.js";
import { planOpenCode } from "../src/providers/opencode.js";

const baseInputs = (
  rawMcpServers: Record<string, McpServer> = {},
): ProviderInputs => ({
  targetRoot: "/tmp/project",
  agentsRoot: "/tmp/project/.agents",
  selected: { skills: [], commands: [], mcp: [], plugins: [] },
  mcpServers: {},
  rawMcpServers,
  claudeSettings: null,
  opencodeConfig: null,
  tuiConfig: null,
});

describe("planOpenCode", () => {
  it("keeps MCP secrets as native OpenCode env references", () => {
    const plan = planOpenCode(
      baseInputs({
        neon: {
          transport: "http",
          url: "https://mcp.neon.tech/mcp",
          headers: { Authorization: "Bearer ${NEON_API_KEY}" },
        },
      }),
    );

    expect(plan.files[0]!.content).toContain("Bearer {env:NEON_API_KEY}");
    expect(plan.files[0]!.content).not.toContain("${NEON_API_KEY}");
  });

  it("merges the OpenCode overlay with managed MCP servers", () => {
    const inputs = baseInputs({
      context7: { transport: "http", url: "https://mcp.context7.com/mcp" },
    });
    inputs.opencodeConfig = {
      permission: { edit: "ask" },
      mcp: { inherited: { enabled: false } },
    };

    const config = JSON.parse(planOpenCode(inputs).files[0]!.content) as {
      permission: unknown;
      mcp: Record<string, unknown>;
    };
    expect(config.permission).toEqual({ edit: "ask" });
    expect(Object.keys(config.mcp)).toEqual(["inherited", "context7"]);
  });

  it("generates project TUI config from the catalog overlay", () => {
    const inputs = baseInputs();
    inputs.tuiConfig = { theme: "opencode" };

    const plan = planOpenCode(inputs);
    const tui = plan.files.find((file) =>
      file.path.endsWith("/.opencode/tui.json"),
    );
    expect(JSON.parse(tui!.content)).toEqual({
      theme: "opencode",
      $schema: "https://opencode.ai/tui.json",
    });
    expect(plan.files).toContainEqual({
      path: "/tmp/project/.opencode/.quiver-tui",
      content: "managed by quiver\n",
    });
  });

  it("leaves unmanaged project TUI config untouched", () => {
    const plan = planOpenCode(baseInputs());
    expect(plan.removeFiles).not.toContain("/tmp/project/.opencode/tui.json");
  });

  it("links selected local plugins into OpenCode discovery", () => {
    const plugin: CatalogPlugin = {
      name: "rtk",
      provider: "opencode",
      sourcePath: "plugins/opencode/rtk.ts",
      absPath: "/tmp/project/.agents/plugins/opencode/rtk.ts",
      digest: "sha256:test",
      requires: ["rtk"],
    };
    const inputs = baseInputs();
    inputs.selected.plugins = [plugin];

    const plan = planOpenCode(inputs);
    expect(plan.symlinks).toContainEqual({
      path: "/tmp/project/.opencode/plugins/rtk.ts",
      target: plugin.absPath,
    });
  });
});
