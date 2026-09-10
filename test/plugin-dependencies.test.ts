import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parse } from "../src/cli.js";
import { loadCatalog, type CatalogConfig } from "../src/catalog/discover.js";
import { pluginToEntry } from "../src/catalog/entries.js";
import { check } from "../src/commands/check.js";
import { list } from "../src/commands/list.js";
import { update } from "../src/commands/update.js";
import { emptyLockfile, readLockfile, writeLockfile } from "../src/lockfile/io.js";
import { checkDependency, extractVersion } from "../src/plugins/check.js";
import { validatePluginRequirements, type PluginRequirement, type VersionedRequirement } from "../src/plugins/requirements.js";
import * as ui from "../src/ui/prompts.js";

vi.mock("../src/providers/write.js", () => ({ checkProviders: vi.fn(() => []) }));

let root: string;
const command = basename(process.execPath);
const requirement = (version = "0.27.2"): VersionedRequirement => ({
  command, versionArgs: ["-e", `process.stdout.write(${JSON.stringify(`rtk ${version}\n`)})`],
  minVersion: "0.20.0", latest: { github: "acme/rtk" },
});

const setup = (requires: PluginRequirement[]) => {
  const agents = join(root, ".agents");
  mkdirSync(join(agents, "plugins"), { recursive: true });
  writeFileSync(join(agents, "plugins/demo.ts"), "export {};\n");
  const config: CatalogConfig = { plugins: { demo: { provider: "opencode", sourcePath: "plugins/demo.ts", requires } } };
  writeFileSync(join(agents, "config.json"), JSON.stringify(config));
  const catalog = loadCatalog({ source: `local:${agents}`, root: agents });
  const plugin = catalog.plugins[0]!;
  const lock = emptyLockfile(`local:${agents}`);
  lock.providers = ["opencode"];
  lock.entries["plugin:demo"] = pluginToEntry(plugin, { kind: "local", root: agents, path: "", digest: plugin.digest });
  writeLockfile(root, lock);
  return { config, lock };
};

const run = async (...flags: string[]) => {
  const { options } = parse(["check", "plugin:demo", "--json", ...flags]);
  await check({ ...options, targetRoot: root });
  return JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quiver-dependencies-"));
  process.exitCode = 0;
  vi.stubEnv("PATH", dirname(process.execPath));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const name of ["info", "warn", "success", "error"] as const) vi.spyOn(ui, name).mockResolvedValue();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

describe("plugin dependency checking", () => {
  it("lists installed dependency versions without a release request", async () => {
    setup([requirement()]);
    const { options } = parse(["list", "--json"]);
    await list({ ...options, targetRoot: root });
    const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
    expect(result.plugins[0].dependencies).toMatchObject([{ installedVersion: "0.27.2", freshness: "not-checked" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[], ["--dry-run"]].map((flags) => ({ flags })))("reports dependency versions during update $flags", async ({ flags }) => {
    setup([requirement()]);
    const before = readFileSync(join(root, "quiver.lock"), "utf8");
    vi.mocked(fetch).mockResolvedValue(new Response('{"tag_name":"v0.48.0"}'));
    const { options } = parse(["update", "plugin:demo", "--json", ...flags]);
    await update({ ...options, targetRoot: root });
    const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
    expect(result.pluginDependencies).toMatchObject([{
      installedVersion: "0.27.2", latestVersion: "0.48.0", freshness: "outdated",
    }]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.github.com/repos/acme/rtk/releases/latest", expect.any(Object));
    expect(readFileSync(join(root, "quiver.lock"), "utf8")).toBe(before);
  });

  it("validates metadata at catalog, local inspection, and lockfile boundaries", async () => {
    const { config } = setup([command]);
    const invalid = [{ command, minVersion: "latest" }];
    config.plugins!.demo!.requires = invalid;
    writeFileSync(join(root, ".agents/config.json"), JSON.stringify(config));
    expect(() => loadCatalog({ source: `local:${root}/.agents`, root: join(root, ".agents") })).toThrow(/minVersion/);
    expect(await run("--offline")).toMatchObject({ ok: false, complete: false, unsafe: [{ id: "plugin:demo", reason: expect.stringContaining("minVersion") }] });
    const lock = JSON.parse(readFileSync(join(root, "quiver.lock"), "utf8"));
    lock.entries["plugin:demo"].requires = invalid;
    writeFileSync(join(root, "quiver.lock"), JSON.stringify(lock));
    expect(() => readLockfile(root)).toThrow(/minVersion/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips dependencies for deselected providers", async () => {
    const { lock } = setup([{ ...requirement(), command: "quiver-missing-binary" }]);
    lock.providers = ["codex"];
    writeLockfile(root, lock);
    expect(await run()).toMatchObject({ ok: true, pluginDependencies: [], pluginRequirements: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { version: "0.27.2", minimum: "0.20.0", status: "compatible", exit: 0 },
    { version: "0.27.2", minimum: "0.48.0", status: "incompatible", exit: 1 },
    { version: "0.48.0-rc.1", minimum: "0.48.0", status: "incompatible", exit: 1 },
    { version: "0.48.0+build.1", minimum: "0.48.0", status: "compatible", exit: 0 },
  ])("checks local $version against $minimum offline", async ({ version, minimum, status, exit }) => {
    const requires = [{ ...requirement(version), minVersion: minimum }];
    setup(requires);
    const before = readFileSync(join(root, "quiver.lock"), "utf8");

    const report = await run("--offline");

    expect(report).toMatchObject({ ok: !exit, complete: true, pluginDependencies: [{
      id: "plugin:demo", command, status, compatibility: status, minVersion: minimum, freshness: "not-checked",
    }] });
    expect(report.pluginDependencies[0].installedVersion).toBe(version.split("+")[0]);
    expect(readFileSync(join(root, "quiver.lock"), "utf8")).toBe(before);
    expect(readLockfile(root)!.entries["plugin:demo"]).toHaveProperty("requires", requires);
    expect(fetch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exit);
  });

  it("preserves string requirements and the missing-requirements JSON field", async () => {
    setup([command, "quiver-missing-binary"]);
    const report = await run("--offline");
    expect(report.pluginDependencies).toMatchObject([
      { command, status: "present", compatibility: "not-configured", freshness: "not-checked" },
      { command: "quiver-missing-binary", status: "missing" },
    ]);
    expect(report.pluginDependencies[0]).not.toHaveProperty("installedVersion");
    expect(report.pluginRequirements).toEqual([{ id: "plugin:demo", command: "quiver-missing-binary" }]);
    expect(process.exitCode).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["-e", "process.stdout.write('development build')"],
    ["-e", "process.exit(3)"],
    ["-e", "process.stdout.write('x'.repeat(100000))"],
  ])("reports failed/unparseable version probes as unknown: %j", async (...versionArgs) => {
    setup([{ ...requirement(), versionArgs }]);
    const report = await run("--offline");
    expect(report).toMatchObject({ ok: false, complete: false, status: "incomplete", pluginDependencies: [{
      status: "unknown", compatibility: "unknown", reason: expect.stringContaining("Installed version unknown"),
    }] });
    expect(process.exitCode).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads stderr version output and passes arguments literally without a shell", async () => {
    const probe = { ...requirement(), versionArgs: ["-e", "process.stderr.write(process.argv[1])", "rtk 0.27.2\n; exit 7"] };
    expect(await checkDependency("plugin:demo", probe, false)).toMatchObject({ status: "compatible", installedVersion: "0.27.2" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not query releases in offline mode", async () => {
    setup([requirement()]);
    expect(await run("--offline")).toMatchObject({ ok: true, complete: true, pluginDependencies: [{ freshness: "not-checked" }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { installed: "0.27.2", latest: "v0.48.0", minimum: "0.20.0", status: "outdated", freshness: "outdated", exit: 0 },
    { installed: "0.27.2", latest: "v0.48.0", minimum: "0.48.0", status: "incompatible", freshness: "outdated", exit: 1 },
    { installed: "0.48.0", latest: "v0.48.0", minimum: "0.20.0", status: "compatible", freshness: "current", exit: 0 },
    { installed: "0.49.0", latest: "v0.48.0", minimum: "0.20.0", status: "compatible", freshness: "current", exit: 0 },
  ])("reports $status for installed $installed and latest $latest", async ({ installed, latest, minimum, status, freshness, exit }) => {
    setup([{ ...requirement(installed), minVersion: minimum }]);
    const before = readFileSync(join(root, "quiver.lock"), "utf8");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ tag_name: latest, draft: false, prerelease: false })));

    const report = await run();

    expect(report).toMatchObject({ ok: !exit, complete: true, pluginDependencies: [{
      status, installedVersion: installed, latestVersion: "0.48.0", freshness,
      compatibility: exit ? "incompatible" : "compatible",
    }] });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.github.com/repos/acme/rtk/releases/latest", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(readFileSync(join(root, "quiver.lock"), "utf8")).toBe(before);
    expect(process.exitCode).toBe(exit);
  });

  it.each([
    { body: "{}", status: 403 },
    { body: "{}", status: 404 },
    { body: "not json", status: 200 },
    { body: '{"tag_name":"nightly"}', status: 200 },
    { body: '{"tag_name":"v0.48.0","draft":true}', status: 200 },
  ])("keeps compatibility known when latest lookup fails: %j", async ({ body, status }) => {
    setup([requirement()]);
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status }));
    expect(await run()).toMatchObject({ ok: false, complete: false, pluginDependencies: [{
      status: "unknown", installedVersion: "0.27.2", compatibility: "compatible", freshness: "unknown",
      reason: expect.stringContaining("Latest version unknown"),
    }] });
    expect(process.exitCode).toBe(1);
  });

  it("reports release network failures without claiming the dependency is current", async () => {
    setup([requirement()]);
    vi.mocked(fetch).mockRejectedValue(new Error("Request timed out"));
    expect(await run()).toMatchObject({ complete: false, pluginDependencies: [{
      status: "unknown", freshness: "unknown", reason: expect.stringContaining("Request timed out"),
    }] });
    expect(process.exitCode).toBe(1);
  });

  it("reports missing release metadata without making network requests", async () => {
    setup([{ command, versionArgs: requirement().versionArgs, minVersion: "0.20.0" }]);
    expect(await run()).toMatchObject({ ok: true, complete: true, pluginDependencies: [{
      status: "compatible", compatibility: "compatible", freshness: "not-checked", reason: expect.stringContaining("No latest release source configured"),
    }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts changed version metadata while preserving source provenance", async () => {
    const { config, lock } = setup([command]);
    config.plugins!.demo!.requires = [requirement()];
    writeFileSync(join(root, ".agents/config.json"), JSON.stringify(config));
    expect(await run("--offline", "--accept")).toMatchObject({ ok: true, accepted: ["plugin:demo"] });
    expect(readLockfile(root)!.entries["plugin:demo"]).toMatchObject({
      requires: [requirement()], source: lock.entries["plugin:demo"]!.source,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders dependency versions and an actionable update notice", async () => {
    setup([requirement()]);
    vi.mocked(fetch).mockResolvedValue(new Response('{"tag_name":"v0.48.0"}'));
    const { options } = parse(["check", "plugin:demo"]);
    await check({ ...options, targetRoot: root });
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining(`plugin:demo dependency ${command}: outdated — installed 0.27.2; requires >=0.20.0 (compatible); latest 0.48.0`));
    expect(ui.info).toHaveBeenCalledWith(expect.stringContaining("1 dependency update available"));
    expect(process.exitCode).toBe(0);
  });
});

describe("plugin version metadata", () => {
  it.each([
    null, {}, [null], [42], [{ command: "../rtk" }], [{ command: "rtk --version" }],
    [{ command: "rtk", minVersion: ">=1.0.0" }], [{ command: "rtk", minVersion: "1.2" }],
    [{ command: "rtk", versionArgs: "--version" }], [{ command: "rtk", versionArgs: [1] }],
    [{ command: "rtk", latest: { github: "https://example.test" } }],
    [{ command: "rtk", latest: { github: "acme/.." } }],
  ].map((value) => [value]))("rejects malformed requirements %j", (value) => {
    expect(() => validatePluginRequirements(value)).toThrow();
  });

  it.each(["rtk 0.27.2", "v0.27.2", "rtk (0.27.2)", "rtk 0.27.2-rc.1+build.2"])("recognizes version output %s", (text) => {
    expect(extractVersion(text)).toMatch(/^0\.27\.2/);
  });

  it.each(["development", "rtk 01.2.3", "rtk 1.2", "rtk 1.2.3.4", "2026-09-10"])("does not coerce ambiguous output %s", (text) => {
    expect(extractVersion(text)).toBeNull();
  });
});
