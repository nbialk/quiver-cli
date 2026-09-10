import { valid } from "semver";

export interface VersionedRequirement {
  command: string;
  /** Defaults to ["--version"]. Executed directly, without a shell. */
  versionArgs?: string[];
  minVersion?: string;
  /** Repository whose latest published full release supplies the version. */
  latest?: { github: string };
}

export type PluginRequirement = string | VersionedRequirement;

export function validatePluginRequirements(value: unknown, label = "Plugin requires"): asserts value is PluginRequirement[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const [index, item] of value.entries()) {
    // Preserve the original string form; unsupported executable names are
    // reported as missing during check rather than changing old lockfile validity.
    if (typeof item === "string") continue;
    const field = `${label}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.command !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(item.command)) {
      throw new Error(`${field}.command must be an executable name without a path`);
    }
    if (item.versionArgs !== undefined && (!Array.isArray(item.versionArgs) ||
        item.versionArgs.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0")))) {
      throw new Error(`${field}.versionArgs must be an array of strings without null bytes`);
    }
    if (item.minVersion !== undefined && (typeof item.minVersion !== "string" || !valid(item.minVersion))) {
      throw new Error(`${field}.minVersion must be a semantic version (for example 0.48.0)`);
    }
    if (item.latest !== undefined && (!item.latest || typeof item.latest !== "object" ||
        Array.isArray(item.latest) || typeof item.latest.github !== "string" ||
        !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(item.latest.github) ||
        [".", ".."].includes(item.latest.github.split("/")[1]))) {
      throw new Error(`${field}.latest.github must be an owner/repository`);
    }
  }
}

export const requirementLabel = (requirement: PluginRequirement): string => typeof requirement === "string"
  ? requirement : `${requirement.command}${requirement.minVersion ? ` >=${requirement.minVersion}` : ""}`;
