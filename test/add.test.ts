import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliOptions } from "../src/cli.js";
import { loadCatalog } from "../src/catalog/discover.js";
import { skillToEntry } from "../src/catalog/entries.js";
import { add } from "../src/commands/add.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";

const skill = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;

let catalogDir: string | undefined;
let repoDir: string | undefined;

afterEach(() => {
  for (const dir of [catalogDir, repoDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  catalogDir = undefined;
  repoDir = undefined;
  process.exitCode = 0;
});

const setup = (config: Record<string, unknown> = {}): void => {
  catalogDir = mkdtempSync(join(tmpdir(), "quiver-add-catalog-"));
  repoDir = mkdtempSync(join(tmpdir(), "quiver-add-repo-"));

  for (const name of ["installed", "new-skill"]) {
    mkdirSync(join(catalogDir, "skills", name), { recursive: true });
    writeFileSync(
      join(catalogDir, "skills", name, "SKILL.md"),
      skill(name, "catalog content"),
    );
  }
  writeFileSync(join(catalogDir, "config.json"), JSON.stringify(config));

  mkdirSync(join(repoDir, ".agents/skills/installed"), { recursive: true });
  writeFileSync(
    join(repoDir, ".agents/skills/installed/SKILL.md"),
    skill("installed", "catalog content"),
  );
  writeFileSync(join(repoDir, ".agents/config.json"), "{}\n");

  const source = `local:${catalogDir}`;
  const catalog = loadCatalog({ source, root: catalogDir });
  const lock = emptyLockfile(source);
  lock.providers = ["opencode"];
  lock.entries["skill:installed"] = skillToEntry(
    catalog.skills.find((entry) => entry.name === "installed")!,
  );
  writeLockfile(repoDir, lock);
};

const options = (id: string): CliOptions => ({
  targetRoot: repoDir!,
  force: false,
  all: true,
  json: false,
  verbose: false,
  accept: false,
  offline: false,
  dryRun: false,
  introspectStdio: false,
  providers: null,
  catalog: null,
  positionals: [id],
});

describe("add", () => {
  it("preserves a locally modified installed skill when adding another skill", async () => {
    setup();
    const installedPath = join(
      repoDir!,
      ".agents/skills/installed/SKILL.md",
    );
    writeFileSync(installedPath, skill("installed", "local modification"));

    await add(options("skill:new-skill"));

    expect(readFileSync(installedPath, "utf8")).toContain("local modification");
    expect(
      readFileSync(join(repoDir!, ".agents/skills/new-skill/SKILL.md"), "utf8"),
    ).toContain("catalog content");
    expect(readLockfile(repoDir!)!.entries).toHaveProperty("skill:new-skill");
  });

  it("merges a new MCP server without replacing existing config state", async () => {
    const newServer = {
      transport: "http",
      url: "https://new.example.test/mcp",
    };
    setup({
      shared: { source: true },
      mcpServers: { new: newServer },
      opencode: { source: true },
    });
    const existingConfig = {
      shared: { locallyModified: true },
      mcpServers: {
        existing: { transport: "http", url: "https://existing.example.test/mcp" },
      },
      plugins: { existing: { provider: "opencode", sourcePath: "existing.ts" } },
      opencode: { locallyModified: true },
      claude: { settings: { locallyModified: true } },
    };
    writeFileSync(
      join(repoDir!, ".agents/config.json"),
      JSON.stringify(existingConfig),
    );
    writeFileSync(join(repoDir!, ".agents/existing.ts"), "export {};\n");

    await add(options("mcp:new"));

    expect(
      JSON.parse(readFileSync(join(repoDir!, ".agents/config.json"), "utf8")),
    ).toEqual({
      ...existingConfig,
      mcpServers: { ...existingConfig.mcpServers, new: newServer },
    });
    expect(readLockfile(repoDir!)!.entries).toHaveProperty("mcp:new");
  });

  it("merges a plugin definition while preserving MCP and provider config", async () => {
    setup();
    mkdirSync(join(catalogDir!, "plugins/opencode"), { recursive: true });
    writeFileSync(join(catalogDir!, "plugins/opencode/new.ts"), "export {};\n");
    writeFileSync(
      join(catalogDir!, "config.json"),
      JSON.stringify({
        plugins: {
          new: {
            provider: "opencode",
            sourcePath: "plugins/opencode/new.ts",
            requires: [],
          },
        },
      }),
    );
    const existingConfig = {
      mcpServers: {
        existing: { transport: "http", url: "https://existing.example.test/mcp" },
      },
      opencode: { locallyModified: true },
    };
    writeFileSync(
      join(repoDir!, ".agents/config.json"),
      JSON.stringify(existingConfig),
    );

    await add(options("plugin:new"));

    expect(
      JSON.parse(readFileSync(join(repoDir!, ".agents/config.json"), "utf8")),
    ).toEqual({
      ...existingConfig,
      plugins: {
        new: {
          provider: "opencode",
          sourcePath: "plugins/opencode/new.ts",
          requires: [],
        },
      },
    });
    expect(
      readFileSync(join(repoDir!, ".agents/plugins/opencode/new.ts"), "utf8"),
    ).toBe("export {};\n");
  });
});
