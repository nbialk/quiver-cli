import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import manifest from "../package.json";
import { DEFAULT_CATALOG_SOURCE, resolveCatalog } from "../src/catalog/resolve.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

it("distributes only the wrapper and build, with an external default catalog", () => {
  expect(manifest.files).toEqual(["bin", "dist"]);
  expect(manifest.bin).toEqual({ "quiver-cli": "bin/quiver-cli.mjs" });
  expect(DEFAULT_CATALOG_SOURCE).toBe("github:nbialk/quiver-catalog");
});

it("requires absolute local catalogs instead of reinterpreting V1 locators", async () => {
  await expect(resolveCatalog("local:template/.agents")).rejects.toThrow("explicit absolute path");
  await expect(resolveCatalog("local:")).rejects.toThrow("explicit absolute path");
  await expect(resolveCatalog(`local:${root}`)).resolves.toEqual({ source: `local:${root}`, root });
  await expect(resolveCatalog(`local:${join(root, "package.json")}`)).rejects.toThrow("Catalog not found");
});

it("uses the validated GitHub resolver through the catalog wrapper", async () => {
  await expect(resolveCatalog("github:owner/repo/../outside")).rejects.toThrow("canonical relative path");
  await expect(resolveCatalog("github:owner/repo#")).rejects.toThrow("invalid or empty #ref");
  await expect(resolveCatalog(`github:owner/repo#${"a".repeat(40)}`, {
    pinnedSha: "b".repeat(40),
  })).rejects.toThrow("does not match the source SHA");
});

describe("package smoke", () => {
  let sandbox: string;
  let packageDir: string;
  let projectDir: string;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "quiver-package-"));
    packageDir = join(sandbox, "package");
    projectDir = join(sandbox, "project");
    mkdirSync(projectDir);
    for (const path of ["package.json", "README.md", "LICENSE", "bin/quiver-cli.mjs"]) {
      mkdirSync(dirname(join(packageDir, path)), { recursive: true });
      copyFileSync(join(root, path), join(packageDir, path));
    }
    for (const path of ["template/.agents/skills/excluded/SKILL.md", ".agents/config.json", "quiver.lock", ".env.local", "src/excluded.ts"]) {
      mkdirSync(dirname(join(packageDir, path)), { recursive: true });
      writeFileSync(join(packageDir, path), "excluded fixture\n");
    }
    symlinkSync(join(root, "node_modules"), join(packageDir, "node_modules"), "junction");
    await build({
      config: join(root, "tsup.config.ts"),
      entry: { cli: join(root, "src/cli.ts") },
      outDir: join(packageDir, "dist"),
      silent: true,
    });
  }, 30_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it("packs only runtime files and npm metadata, excluding template and local state", () => {
    const output = execFileSync("npm", [
      "pack", "--dry-run", "--ignore-scripts", "--json", "--offline", "--no-update-notifier",
      `--cache=${join(sandbox, "npm-cache")}`,
    ], { cwd: packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    const [packed] = JSON.parse(output) as { files: { path: string }[] }[];
    expect(packed!.files.map(({ path }) => path).sort()).toEqual([
      "LICENSE", "README.md", "bin/quiver-cli.mjs", "dist/cli.js", "package.json",
    ]);
  });

  it("dispatches help, version, a local command and errors through the actual bin wrapper", () => {
    const invoke = (...args: string[]) => spawnSync(process.execPath, [
      join(packageDir, manifest.bin["quiver-cli"]), ...args, "--json",
    ], {
      cwd: projectDir,
      env: { ...process.env, CI: "1", QUIVER_NO_UPDATE_NOTIFIER: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });

    const help = invoke("help");
    expect(help.status, help.stderr).toBe(0);
    const { help: text } = JSON.parse(help.stdout);
    expect(text).toContain("migrate");
    expect(text).not.toMatch(/upstream|outdated/);

    const version = invoke("version");
    expect(version.status, version.stderr).toBe(0);
    expect(JSON.parse(version.stdout)).toEqual({ ok: true, version: manifest.version });

    const initialized = invoke("init", "--empty", "--providers=claude");
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({ ok: true, installed: [] });
    const lock = readFileSync(join(projectDir, "quiver.lock"), "utf8");
    expect(JSON.parse(lock)).toMatchObject({ version: 2, catalog: { source: DEFAULT_CATALOG_SOURCE }, entries: {} });

    const invalid = invoke("upstream");
    expect(invalid.status, invalid.stderr).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(readFileSync(join(projectDir, "quiver.lock"), "utf8")).toBe(lock);
  });
});
