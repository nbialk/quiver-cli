import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { lt, valid } from "semver";

import type { PluginRequirement } from "./requirements.js";

const execute = promisify(execFile);

export interface DependencyReport {
  id: string;
  command: string;
  status: "present" | "missing" | "compatible" | "incompatible" | "outdated" | "unknown";
  installedVersion?: string;
  minVersion?: string;
  latestVersion?: string;
  compatibility: "not-configured" | "compatible" | "incompatible" | "unknown";
  freshness: "not-checked" | "current" | "outdated" | "unknown";
  reason?: string;
}

const findCommand = (command: string): string | null => {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(command)) return null;
  const extensions = process.platform === "win32"
    ? ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const path = resolve(dir, command + extension);
      try {
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return null;
};

export const hasCommand = (command: string): boolean => findCommand(command) !== null;

// Keep prerelease/build identifiers and reject partial versions instead of
// coercing arbitrary numbers (dates, commit IDs) into a healthy version.
export const extractVersion = (output: string): string | null => {
  const match = output.match(/(?:^|[\s(])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[\s)])/);
  return match ? valid(match[1]) : null;
};

const latestVersion = async (repo: string): Promise<string> => {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status})`);
  const release: unknown = await response.json();
  if (!release || typeof release !== "object" || !("tag_name" in release) ||
      typeof release.tag_name !== "string" || ("draft" in release && release.draft) ||
      ("prerelease" in release && release.prerelease)) {
    throw new Error("GitHub returned no published full release");
  }
  const version = valid(release.tag_name);
  if (!version) throw new Error("Latest release tag is not a semantic version");
  return version;
};

export const checkDependency = async (
  id: string, requirement: PluginRequirement, online: boolean,
): Promise<DependencyReport> => {
  const command = typeof requirement === "string" ? requirement : requirement.command;
  const minVersion = typeof requirement === "string" ? undefined : requirement.minVersion;
  const report: DependencyReport = {
    id, command, status: "present", compatibility: minVersion ? "unknown" : "not-configured",
    freshness: "not-checked", ...(minVersion ? { minVersion } : {}),
  };
  const executable = findCommand(command);
  if (!executable) return { ...report, status: "missing", reason: "Executable not found in PATH" };
  if (typeof requirement === "string") return { ...report, reason: "Presence only; version metadata not configured" };
  try {
    const { stdout, stderr } = await execute(executable, requirement.versionArgs ?? ["--version"], {
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
    });
    const installed = extractVersion(`${stdout}\n${stderr}`);
    if (!installed) throw new Error("Version command returned no recognizable semantic version");
    report.installedVersion = installed;
    if (minVersion) {
      report.compatibility = lt(installed, minVersion) ? "incompatible" : "compatible";
      report.status = report.compatibility;
    }
  } catch (error) {
    report.status = "unknown";
    report.reason = `Installed version unknown: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (online && requirement.latest) {
    try {
      report.latestVersion = await latestVersion(requirement.latest.github);
      if (report.installedVersion) {
        report.freshness = lt(report.installedVersion, report.latestVersion) ? "outdated" : "current";
        if (report.freshness === "outdated" && report.status !== "incompatible") report.status = "outdated";
      } else {
        report.freshness = "unknown";
      }
    } catch (error) {
      report.freshness = "unknown";
      if (report.status !== "incompatible") report.status = "unknown";
      report.reason = [report.reason, `Latest version unknown: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join(". ");
    }
  } else if (online) {
    report.reason = [report.reason, "No latest release source configured"].filter(Boolean).join(". ");
  }
  return report;
};

export const dependencyLabel = (item: DependencyReport): string => {
  const details = [
    item.installedVersion ? `installed ${item.installedVersion}` : undefined,
    item.minVersion ? `requires >=${item.minVersion} (${item.compatibility})` : undefined,
    item.latestVersion ? `latest ${item.latestVersion}` : undefined,
    item.freshness === "not-checked" && item.installedVersion ? "freshness not checked" : undefined,
    item.reason,
  ].filter(Boolean);
  return `${item.id} dependency ${item.command}: ${item.status}${details.length ? ` — ${details.join("; ")}` : ""}`;
};
