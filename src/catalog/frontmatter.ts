// Minimal YAML frontmatter reader for SKILL.md: extracts top-level scalar
// fields (name, description, version) from a leading --- ... --- block, with
// metadata.version as a fallback. Supports folded
// (`>`) and literal (`|`) block scalars so multi-line descriptions are read in
// full. Good enough for the open agent skills standard; avoids a full YAML dep.
export const readFrontmatter = (
  content: string,
): Record<string, string> => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  let metadataVersion: string | undefined;

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

    if (key === "metadata" && !value) {
      const nested: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || /^\s/.test(lines[i + 1]!))) {
        nested.push(lines[++i]!);
      }
      const indent = nested.find((item) => item.trim() && !item.trimStart().startsWith("#"))?.match(/^\s*/)?.[0].length;
      if (indent !== undefined) {
        const versionLine = nested.map((item) => item.slice(indent)).find((item) => /^version\s*:/.test(item));
        if (versionLine) metadataVersion = readFrontmatter(`---\n${versionLine}\n---`).version;
      }
      fields[key] = value;
      continue;
    }

    // Block scalar: gather following indented lines as the value.
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith(">");
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
  if (!fields.version && metadataVersion) fields.version = metadataVersion;
  return fields;
};
