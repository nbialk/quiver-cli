import { jsonDigest } from "../catalog/digest.js";
import type { McpToolSnapshot } from "../lockfile/schema.js";
import type { IntrospectedTool } from "./introspect.js";
import { estimateTokens } from "./tokens.js";

// Build the lockfile tool snapshot: description kept in plain text (so poisoning
// diffs are human-readable), inputSchema reduced to a canonical hash, plus a
// token estimate (the full schema is only available here, not in the lock).
export const toSnapshot = (
  tools: IntrospectedTool[],
): Record<string, McpToolSnapshot> => {
  const snapshot: Record<string, McpToolSnapshot> = {};
  for (const tool of tools) {
    snapshot[tool.name] = {
      description: tool.description,
      inputSchemaHash: jsonDigest(tool.inputSchema),
      tokens: estimateTokens(tool),
    };
  }
  return snapshot;
};

// Copy token estimates from a fresh snapshot onto a stored one recorded before
// estimates existed. Only called on an empty diff (identical descriptions and
// schema hashes), so this never masks drift. Returns true when anything changed.
export const backfillTokens = (
  stored: Record<string, McpToolSnapshot>,
  current: Record<string, McpToolSnapshot>,
): boolean => {
  let changed = false;
  for (const [name, tool] of Object.entries(stored)) {
    const estimate = current[name]?.tokens;
    if (tool.tokens === undefined && estimate !== undefined) {
      tool.tokens = estimate;
      changed = true;
    }
  }
  return changed;
};
