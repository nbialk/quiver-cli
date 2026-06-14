import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkForUpdate,
  compareSemver,
  getCurrentVersion,
  notifierSuppressed,
} from "../src/version/notifier.js";

describe("compareSemver", () => {
  it("orders by major, minor, patch", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
  });

  it("tolerates a leading v and short versions", () => {
    expect(compareSemver("v0.3.0", "0.2.9")).toBe(1);
    expect(compareSemver("1", "1.0.0")).toBe(0);
  });

  it("sorts a prerelease below its release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
  });
});

describe("checkForUpdate", () => {
  let cacheDir: string;
  const cacheFile = (): string => join(cacheDir, "quiver", "update-check.json");

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "quiver-cache-"));
    process.env["XDG_CACHE_HOME"] = cacheDir;
  });

  afterEach(() => {
    delete process.env["XDG_CACHE_HOME"];
    rmSync(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const mockFetch = (version: string) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  it("fetches and writes the cache on a cold check", async () => {
    const fetchSpy = mockFetch("99.0.0");
    const info = await checkForUpdate();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(info.latest).toBe("99.0.0");
    expect(info.updateAvailable).toBe(true);
    expect(existsSync(cacheFile())).toBe(true);
  });

  it("uses a fresh cache without hitting the network", async () => {
    const fetchSpy = mockFetch("99.0.0");
    await checkForUpdate(); // cold: writes a fresh cache entry
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    const info = await checkForUpdate(); // fresh cache: no network
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info.latest).toBe("99.0.0");
  });

  it("forces a network check even with a fresh cache", async () => {
    mockFetch("99.0.0");
    await checkForUpdate();
    const fetchSpy = mockFetch("99.0.0");
    await checkForUpdate({ force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws when the registry is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const info = await checkForUpdate();
    expect(info.latest).toBeNull();
    expect(info.updateAvailable).toBe(false);
  });

  it("returns latest=null on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    const info = await checkForUpdate();
    expect(info.latest).toBeNull();
  });

  it("reports no update when latest is not newer", async () => {
    const current = getCurrentVersion();
    mockFetch(current);
    const info = await checkForUpdate();
    expect(info.updateAvailable).toBe(false);
  });
});

describe("notifierSuppressed", () => {
  const original = {
    optOut: process.env["QUIVER_NO_UPDATE_NOTIFIER"],
    ci: process.env["CI"],
    tty: process.stdout.isTTY,
  };

  afterEach(() => {
    if (original.optOut === undefined) delete process.env["QUIVER_NO_UPDATE_NOTIFIER"];
    else process.env["QUIVER_NO_UPDATE_NOTIFIER"] = original.optOut;
    if (original.ci === undefined) delete process.env["CI"];
    else process.env["CI"] = original.ci;
    process.stdout.isTTY = original.tty;
  });

  it("suppresses for --json", () => {
    delete process.env["QUIVER_NO_UPDATE_NOTIFIER"];
    delete process.env["CI"];
    process.stdout.isTTY = true;
    expect(notifierSuppressed(true)).toBe(true);
  });

  it("suppresses when the opt-out env is set", () => {
    process.env["QUIVER_NO_UPDATE_NOTIFIER"] = "1";
    expect(notifierSuppressed(false)).toBe(true);
  });

  it("suppresses in CI", () => {
    delete process.env["QUIVER_NO_UPDATE_NOTIFIER"];
    process.env["CI"] = "true";
    expect(notifierSuppressed(false)).toBe(true);
  });

  it("suppresses without a TTY", () => {
    delete process.env["QUIVER_NO_UPDATE_NOTIFIER"];
    delete process.env["CI"];
    process.stdout.isTTY = false;
    expect(notifierSuppressed(false)).toBe(true);
  });

  it("allows on an interactive TTY with no opt-out", () => {
    delete process.env["QUIVER_NO_UPDATE_NOTIFIER"];
    delete process.env["CI"];
    process.stdout.isTTY = true;
    expect(notifierSuppressed(false)).toBe(false);
  });
});
