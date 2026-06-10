import { jsonDigest } from "../catalog/digest.js";
import type { McpToolSnapshot } from "../lockfile/schema.js";
import type { IntrospectedTool } from "./introspect.js";

// Build the lockfile tool snapshot: description kept in plain text (so poisoning
// diffs are human-readable), inputSchema reduced to a canonical hash.
export const toSnapshot = (
  tools: IntrospectedTool[],
): Record<string, McpToolSnapshot> => {
  const snapshot: Record<string, McpToolSnapshot> = {};
  for (const tool of tools) {
    snapshot[tool.name] = {
      description: tool.description,
      inputSchemaHash: jsonDigest(tool.inputSchema),
    };
  }
  return snapshot;
};
