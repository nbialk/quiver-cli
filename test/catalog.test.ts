import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, jsonDigest } from "../src/catalog/digest.js";
import { loadCatalog, validateMcpServer } from "../src/catalog/discover.js";
import { readFrontmatter } from "../src/catalog/frontmatter.js";
import { readSkillReferences } from "../src/catalog/index.js";
import { materializeCatalog } from "../src/catalog/materialize.js";
import { resolveGithubDirectory } from "../src/sources/github.js";

vi.mock("../src/sources/github.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/sources/github.js")>(),
  resolveGithubDirectory: vi.fn(),
}));

let catalogDir: string | undefined;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network is forbidden"); }));
});

afterEach(() => {
  if (catalogDir) rmSync(catalogDir, { recursive: true, force: true });
  catalogDir = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("readFrontmatter", () => {
  it("parses top-level scalars and strips quotes", () => {
    const fm = readFrontmatter(
      `---\nname: my-skill\ndescription: "Does a thing"\n---\nbody`,
    );
    expect(fm).toEqual({ name: "my-skill", description: "Does a thing" });
  });

  it("returns empty when no frontmatter block", () => {
    expect(readFrontmatter("# Heading\nno frontmatter")).toEqual({});
  });

  it("ignores nested/indented keys", () => {
    const fm = readFrontmatter(`---\nname: x\nmeta:\n  nested: y\n---\n`);
    expect(fm).toEqual({ name: "x", meta: "" });
  });

  it("reads metadata.version without promoting other nested fields", () => {
    expect(readFrontmatter(`---\nname: prisma-cli\nmetadata:\n  author: prisma\n  version: "7.9.1"\n---`))
      .toEqual({ name: "prisma-cli", metadata: "", version: "7.9.1" });
  });

  it.each([
    `version: 4.3.1\nmetadata:\n  version: 1.0.0`,
    `metadata:\n  version: 1.0.0\nversion: 4.3.1`,
  ])("prefers top-level version regardless of field order", (fields) => {
    expect(readFrontmatter(`---\n${fields}\n---`).version).toBe("4.3.1");
  });

  it("ignores versions outside direct metadata children", () => {
    expect(readFrontmatter(`---\nmetadata:\n  author: demo\n  other:\n    version: 9\nconfig:\n  version: 8\n---`).version).toBeUndefined();
  });

  it.each([">", ">-", ">+", "|", "|-", "|+"])("reads descriptions with block marker %s", (marker) => {
    const fm = readFrontmatter(`---\ndescription: ${marker}\n  First line\n  second line\nversion: 1\n---`);
    expect(fm.description).toBe(marker.startsWith(">") ? "First line second line" : "First line\nsecond line");
    expect(fm.version).toBe("1");
  });
});

describe("digest", () => {
  it("canonicalises object keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("produces stable jsonDigest regardless of key order", () => {
    expect(jsonDigest({ a: 1, b: 2 })).toBe(jsonDigest({ b: 2, a: 1 }));
  });
});

describe("loadCatalog", () => {
  it.each([
    { server: { transport: "http", url: " " }, reason: "url must be a nonempty string" },
    { server: { transport: "stdio", command: 42 }, reason: "command must be a nonempty string" },
    { server: { transport: "stdio", command: "run", args: "private-value" }, reason: "args must be an array of strings" },
    { server: { transport: "stdio", command: "run", args: ["private-value", 42] }, reason: "args must be an array of strings" },
    { server: { transport: "stdio", command: "run", env: null }, reason: "env must be a plain string-valued record" },
    { server: { transport: "stdio", command: "run", env: { TOKEN: ["private-value"] } }, reason: "env must be a plain string-valued record" },
    { server: { transport: "http", url: "${MCP_URL}", headers: ["private-value"] }, reason: "headers must be a plain string-valued record" },
    { server: { transport: "http", url: "${MCP_URL}", headers: { Authorization: { token: "private-value" } } }, reason: "headers must be a plain string-valued record" },
  ])("rejects invalid source MCP configuration: $reason", ({ server, reason }) => {
    catalogDir = mkdtempSync(join(tmpdir(), "quiver-catalog-mcp-"));
    writeFileSync(join(catalogDir, "config.json"), JSON.stringify({ mcpServers: { demo: server } }));

    expect(() => loadCatalog({ source: `local:${catalogDir}`, root: catalogDir! }))
      .toThrow(new Error(`MCP server "demo".${reason}`));
  });

  it("accepts valid MCP optional fields and preserves environment placeholders", () => {
    catalogDir = mkdtempSync(join(tmpdir(), "quiver-catalog-mcp-"));
    const mcpServers = {
      http: { transport: "http", url: "${MCP_URL}", headers: { Authorization: "Bearer ${TOKEN}" } },
      stdio: { transport: "stdio", command: "${MCP_COMMAND}", args: ["--mode", "${MODE}", ""], env: { TOKEN: "${TOKEN}", EMPTY: "" } },
    };
    writeFileSync(join(catalogDir, "config.json"), JSON.stringify({ mcpServers }));

    const catalog = loadCatalog({ source: `local:${catalogDir}`, root: catalogDir });

    expect(catalog.mcp).toEqual(Object.entries(mcpServers).map(([name, server]) => ({ name, server, configDigest: jsonDigest(server) })));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-plain MCP header records without exposing their contents", () => {
    expect(() => validateMcpServer({
      transport: "http", url: "${MCP_URL}", headers: new Map([["Authorization", "private-value"]]),
    })).toThrow(new Error("MCP server.headers must be a plain string-valued record"));
  });

  it("discovers configured local plugins", () => {
    catalogDir = mkdtempSync(join(tmpdir(), "quiver-catalog-"));
    mkdirSync(join(catalogDir, "plugins/opencode"), { recursive: true });
    writeFileSync(
      join(catalogDir, "plugins/opencode/rtk.ts"),
      "export const plugin = async () => ({});\n",
    );
    writeFileSync(
      join(catalogDir, "config.json"),
      JSON.stringify({
        plugins: {
          rtk: {
            provider: "opencode",
            sourcePath: "plugins/opencode/rtk.ts",
            requires: ["rtk"],
          },
        },
      }),
    );

    const catalog = loadCatalog({ source: "local:test", root: catalogDir });
    expect(catalog.plugins).toMatchObject([
      {
        name: "rtk",
        provider: "opencode",
        sourcePath: "plugins/opencode/rtk.ts",
        requires: ["rtk"],
      },
    ]);
  });

  it.each(["../outside.ts", "/tmp/outside.ts", "C:\\outside.ts"])(
    "rejects plugin source path %s",
    (sourcePath) => {
      catalogDir = mkdtempSync(join(tmpdir(), "quiver-catalog-"));
      writeFileSync(
        join(catalogDir, "config.json"),
        JSON.stringify({
          plugins: { unsafe: { provider: "opencode", sourcePath } },
        }),
      );

      expect(() =>
        loadCatalog({ source: "local:test", root: catalogDir! }),
      ).toThrow(/sourcePath.*(beneath|escapes)/);
    },
  );

  it.each(["../unsafe", "/unsafe", "dir\\unsafe"])(
    "rejects plugin name %s",
    (name) => {
      catalogDir = mkdtempSync(join(tmpdir(), "quiver-catalog-"));
      writeFileSync(
        join(catalogDir, "config.json"),
        JSON.stringify({
          plugins: {
            [name]: { provider: "opencode", sourcePath: "plugin.ts" },
          },
        }),
      );

      expect(() =>
        loadCatalog({ source: "local:test", root: catalogDir! }),
      ).toThrow(/Invalid plugin name/);
    },
  );
});

const catalogWithIndex = (index: unknown, ownSkills: string[] = []) => {
  catalogDir = mkdtempSync(join(tmpdir(), "quiver-catalog-index-"));
  writeFileSync(join(catalogDir, "catalog.json"), JSON.stringify(index));
  for (const path of ownSkills) {
    mkdirSync(join(catalogDir, "skills", path), { recursive: true });
    writeFileSync(join(catalogDir, "skills", path, "SKILL.md"), "# Own skill\n");
  }
  const source = { source: `local:${catalogDir}`, root: catalogDir };
  return { source, catalog: loadCatalog(source) };
};

describe("readSkillReferences", () => {
  it("reads the exact V1 index shape without importing provenance or fetching references", () => {
    const { source, catalog } = catalogWithIndex({
      version: 1,
      skills: {
        shadcn: { source: "github:shadcn-ui/ui/skills/shadcn#main", group: "ui", description: "Build components" },
        "vercel-react-best-practices": {
          source: "github:vercel-labs/agent-skills/skills/react-best-practices#main",
          group: "code", description: "React performance",
        },
      },
    }, ["code/cleanup", "integrations/posthog-custom"]);
    const original = structuredClone(catalog);

    expect(readSkillReferences(source.root, catalog)).toEqual([
      {
        name: "shadcn", source: "github:shadcn-ui/ui/skills/shadcn#main", group: "ui",
        frontmatter: { name: "shadcn", description: "Build components", version: null },
      },
      {
        name: "vercel-react-best-practices",
        source: "github:vercel-labs/agent-skills/skills/react-best-practices#main", group: "code",
        frontmatter: { name: "vercel-react-best-practices", description: "React performance", version: null },
      },
    ]);
    expect(catalog).toEqual(original);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps five filesystem-owned skills separate from fifteen published pointers", () => {
    const pointers = {
      "agent-browser": "github:vercel-labs/agent-browser/skills/agent-browser#main",
      "find-skills": "github:vercel-labs/skills/skills/find-skills#main",
      hono: "github:honojs/skills/skills/hono#main",
      humanizer: "github:blader/humanizer#main",
      impeccable: "github:pbakaus/impeccable/.pi/skills/impeccable#main",
      improve: "github:shadcn/improve/skills/improve#main",
      langfuse: "github:langfuse/skills/skills/langfuse#main",
      "prisma-cli": "github:prisma/skills/prisma-cli#main",
      "prisma-client-api": "github:prisma/skills/prisma-client-api#main",
      shadcn: "github:shadcn-ui/ui/skills/shadcn#main",
      "skill-creator": "github:anthropics/skills/skills/skill-creator#main",
      skybridge: "github:alpic-ai/skybridge/skills/skybridge#main",
      supabase: "github:supabase/agent-skills/skills/supabase#main",
      "supabase-postgres-best-practices": "github:supabase/agent-skills/skills/supabase-postgres-best-practices#main",
      "vercel-react-best-practices": "github:vercel-labs/agent-skills/skills/react-best-practices#main",
    };
    const { source, catalog } = catalogWithIndex({
      version: 1, skills: Object.fromEntries(Object.entries(pointers).map(([name, source]) => [name, { source }])),
    }, ["code/cleanup", "repo/repo-ci", "repo/repo-init-node", "repo/repo-init-next-js", "integrations/posthog-custom"]);
    const references = readSkillReferences(source.root, catalog);
    expect(catalog.skills.map(({ name }) => name)).toEqual([
      "cleanup", "posthog-custom", "repo-ci", "repo-init-next-js", "repo-init-node",
    ]);
    expect(references).toHaveLength(15);
    expect(Object.fromEntries(references.map(({ name, source }) => [name, source]))).toEqual(pointers);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it("defaults optional presentation fields without inventing a content baseline", () => {
    const { source, catalog } = catalogWithIndex({
      version: 1, skills: { humanizer: { source: "github:Blader/Humanizer", description: null } },
    });
    expect(readSkillReferences(source.root, catalog)).toEqual([{
      name: "humanizer", source: "github:Blader/Humanizer", group: "general",
      frontmatter: { name: "humanizer", description: null, version: null },
    }]);
  });

  it("returns no references without catalog.json, ignoring V1 upstream metadata", () => {
    const { source, catalog } = catalogWithIndex({ version: 1, skills: {} });
    rmSync(join(source.root, "catalog.json"));
    writeFileSync(join(source.root, "upstreams.json"), "invalid legacy metadata");
    expect(readSkillReferences(source.root, catalog)).toEqual([]);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { version: 2, skills: {} }, { version: "1", skills: {} },
    { version: 1 }, { version: 1, skills: [] }, { version: 1, skills: null },
    { version: 1, skills: {}, fetchedAt: "2026-09-08" },
    { version: 1, references: {} },
  ])("rejects invalid index structure %j", (index) => {
    const { source, catalog } = catalogWithIndex(index);
    expect(() => readSkillReferences(source.root, catalog)).toThrow(/Invalid catalog.json/);
  });

  it("reports malformed JSON with index context", () => {
    const { source, catalog } = catalogWithIndex({});
    writeFileSync(join(source.root, "catalog.json"), "{");
    expect(() => readSkillReferences(source.root, catalog)).toThrow(/Invalid catalog.json.*JSON/);
  });

  it.each([
    null, [], "github:a/b", {}, { source: 42 },
    { source: "github:a/b", group: [] }, { source: "github:a/b", group: null },
    { source: "github:a/b", group: " " }, { source: "github:a/b", group: "bad\nlabel" },
    { source: "github:a/b", description: {} },
    ...["metadata", "commit", "fetchedAt", "digest", "ref", "version", "curated"].map((key) => ({ source: "github:a/b", [key]: null })),
  ])("rejects invalid pointer fields %j", (pointer) => {
    const { source, catalog } = catalogWithIndex({ version: 1, skills: { invalid: pointer } });
    expect(() => readSkillReferences(source.root, catalog)).toThrow(/Invalid catalog.json skill "invalid"/);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it.each([
    "local:/tmp/skill", "skill:another-alias", "https://github.com/a/b", "gitlab:a/b",
    "github:owner", "github:a/b/../outside", "github:a/b/a\\b", "github:a/b#", "github:a/b#main#extra",
  ])("rejects unsupported or invalid pointer source %s", (pointer) => {
    const { source, catalog } = catalogWithIndex({ version: 1, skills: { invalid: { source: pointer } } });
    expect(() => readSkillReferences(source.root, catalog)).toThrow(/Invalid catalog.json skill "invalid" source/);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });

  it.each(["", ".", "..", "../escape", "dir/name", "dir\\name", "C:drive", "bad\0name", "bad\nname", "name.", "name ", "CON", "nul.md", "__proto__", "constructor", "prototype"])(
    "rejects unsafe reference name %s", (name) => {
      const { source, catalog } = catalogWithIndex({ version: 1, skills: { [name]: { source: "github:a/b" } } });
      expect(() => readSkillReferences(source.root, catalog)).toThrow(/Invalid catalog.json skill name/);
    },
  );

  it.each(["shadcn", "SHADCN"])("rejects collision %s with an owned skill", (name) => {
    const { source, catalog } = catalogWithIndex({ version: 1, skills: { [name]: { source: "github:a/b" } } }, ["ui/shadcn"]);
    expect(() => readSkillReferences(source.root, catalog)).toThrow(/Duplicate skill name.*case-insensitive/);
  });

  it("rejects case-insensitive collisions between references", () => {
    const { source, catalog } = catalogWithIndex({
      version: 1, skills: { shadcn: { source: "github:a/b" }, Shadcn: { source: "github:c/d" } },
    });
    expect(() => readSkillReferences(source.root, catalog)).toThrow(/Duplicate skill name/);
  });

  it("rejects a linked index rather than following it", () => {
    const { source, catalog } = catalogWithIndex({ version: 1, skills: {} });
    rmSync(join(source.root, "catalog.json"));
    writeFileSync(join(source.root, "other.json"), '{"version":1,"skills":{}}');
    symlinkSync("other.json", join(source.root, "catalog.json"));
    expect(() => readSkillReferences(source.root, catalog)).toThrow(/symlinked|regular file/);
  });

  it("does not materialize catalog.json into the project", () => {
    const { source, catalog } = catalogWithIndex({ version: 1, skills: { shadcn: { source: "github:shadcn-ui/ui/skills/shadcn#main" } } });
    const target = join(source.root, "project");
    materializeCatalog(target, source, catalog, { skills: [], commands: [], mcp: [], plugins: [] });
    expect(existsSync(join(target, ".agents/config.json"))).toBe(true);
    expect(existsSync(join(target, ".agents/catalog.json"))).toBe(false);
    expect(resolveGithubDirectory).not.toHaveBeenCalled();
  });
});
