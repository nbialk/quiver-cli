import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// Load .env.local (if present) into process.env without clobbering existing
// values, so MCP env-var placeholders can be interpolated.
export const loadEnvLocal = (targetRoot: string): void => {
  const path = resolve(targetRoot, ".env.local");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

// Collect the distinct ${VAR} placeholder names referenced anywhere in a value
// (e.g. the selected MCP server definitions), in stable sorted order.
export const collectEnvVars = (value: unknown): string[] => {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([^}]+)\}/g)) found.add(m[1]!);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v !== null && typeof v === "object") {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return [...found].sort((a, b) => a.localeCompare(b));
};

// Replace ${VAR} placeholders with process.env values. Missing vars are left
// as-is and reported via onMissing so callers can warn the user.
export const interpolateEnvVars = <T>(
  value: T,
  onMissing?: (name: string) => void,
): T => {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
      const env = process.env[name];
      if (env === undefined) {
        onMissing?.(name);
        return match;
      }
      return env;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnvVars(v, onMissing)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnvVars(v, onMissing);
    }
    return out as T;
  }
  return value;
};
