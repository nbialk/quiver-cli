import type { McpToolSnapshot } from "../lockfile/schema.js";

export interface ToolDiff {
  added: string[];
  removed: string[];
  schemaChanged: string[];
  /** Security-critical: description changed (tool-description poisoning). */
  descriptionChanged: { name: string; before: string; after: string }[];
}

export const diffSnapshots = (
  before: Record<string, McpToolSnapshot>,
  after: Record<string, McpToolSnapshot>,
): ToolDiff => {
  const diff: ToolDiff = {
    added: [],
    removed: [],
    schemaChanged: [],
    descriptionChanged: [],
  };

  for (const name of Object.keys(after)) {
    if (!(name in before)) diff.added.push(name);
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) {
      diff.removed.push(name);
      continue;
    }
    const b = before[name]!;
    const a = after[name]!;
    if (b.inputSchemaHash !== a.inputSchemaHash) diff.schemaChanged.push(name);
    if (b.description !== a.description) {
      diff.descriptionChanged.push({
        name,
        before: b.description,
        after: a.description,
      });
    }
  }

  diff.added.sort();
  diff.removed.sort();
  diff.schemaChanged.sort();
  diff.descriptionChanged.sort((x, y) => x.name.localeCompare(y.name));
  return diff;
};

export const isEmptyDiff = (d: ToolDiff): boolean =>
  d.added.length === 0 &&
  d.removed.length === 0 &&
  d.schemaChanged.length === 0 &&
  d.descriptionChanged.length === 0;
