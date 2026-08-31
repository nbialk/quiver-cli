import { canonicalJson } from "../catalog/digest.js";
import type { IntrospectedTool } from "./introspect.js";

// Rough token estimate for a tool definition as it lands in a model's context
// (name + description + full input schema). chars/4 is a common heuristic;
// exact counts vary by model and provider serialization anyway, so values are
// always displayed with a "~" prefix.
export const estimateTokens = (tool: IntrospectedTool): number =>
  Math.ceil(
    canonicalJson({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }).length / 4,
  );

// "~840 tok" below 1000, "~45.2k tok" above.
export const formatTokens = (n: number): string =>
  n < 1000 ? `~${n} tok` : `~${(n / 1000).toFixed(1)}k tok`;

// Sum per-tool estimates from a lock snapshot; null when any tool has no
// recorded estimate yet (older lockfile - run `quiver-cli check` to backfill).
export const sumTokens = (
  tools: Record<string, { tokens?: number }>,
): number | null => {
  let total = 0;
  for (const tool of Object.values(tools)) {
    if (tool.tokens === undefined) return null;
    total += tool.tokens;
  }
  return total;
};
