// Node version guard. The interactive picker relies on @clack/prompts, which
// requires `node:util.styleText` (Node >= 20.12.0). On older runtimes the import
// fails and the CLI silently degrades to an ugly numbered fallback. Rather than
// let that happen, fail fast for interactive commands with an actionable error.

// Minimum Node version that ships `util.styleText` (required by @clack/prompts).
export const MIN_NODE = "20.12.0";

// Commands that open interactive multiselect prompts and therefore depend on
// clack being loadable. Non-interactive commands keep working on older Node.
export const INTERACTIVE_COMMANDS = new Set(["init", "add", "remove", "rm"]);

const parse = (v: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = v
    .replace(/^v/, "")
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
  return [major, minor, patch];
};

// True when `current` is older than `min` (semver-ish, numeric compare).
export const isBelow = (current: string, min: string): boolean => {
  const a = parse(current);
  const b = parse(min);
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
};

export interface GuardResult {
  ok: boolean;
  message?: string;
}

// Decide whether an interactive command may proceed on the current runtime.
// Only blocks when the command is interactive AND Node is too old.
export const checkNodeForCommand = (
  command: string,
  nodeVersion: string = process.versions.node,
): GuardResult => {
  if (!INTERACTIVE_COMMANDS.has(command)) return { ok: true };
  if (!isBelow(nodeVersion, MIN_NODE)) return { ok: true };
  return {
    ok: false,
    message:
      `quiver-cli "${command}" needs Node >= ${MIN_NODE} for its interactive ` +
      `menu, but you are on v${nodeVersion}.\n` +
      `Upgrade Node (e.g. \`nvm install 24 && nvm use 24\`), then retry.\n` +
      `Or run non-interactively with --all to keep everything without prompts.`,
  };
};
