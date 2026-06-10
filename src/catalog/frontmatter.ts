// Minimal YAML frontmatter reader for SKILL.md: extracts top-level scalar
// fields (name, description) from a leading --- ... --- block. Supports folded
// (`>`) and literal (`|`) block scalars so multi-line descriptions are read in
// full. Good enough for the open agent skills standard; avoids a full YAML dep.
export const readFrontmatter = (
  content: string,
): Record<string, string> => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    // Skip nested/indented keys; only top-level scalars.
    if (/^\s/.test(rawLine)) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();

    // Block scalar: gather following indented lines as the value.
    if (value === ">" || value === "|") {
      const folded = value === ">";
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
        block.push(lines[i + 1]!.trim());
        i += 1;
      }
      fields[key] = folded ? block.join(" ") : block.join("\n");
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
};
