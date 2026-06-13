// Thin UI layer over @clack/prompts with graceful console fallbacks.
//
// clack is loaded lazily and cached. If it can't be loaded, every helper
// degrades to plain console output so the CLI keeps working.

type Clack = typeof import("@clack/prompts");

let clackPromise: Promise<Clack | null> | undefined;

export const loadClack = async (): Promise<Clack | null> => {
  if (clackPromise === undefined) {
    clackPromise = import("@clack/prompts").catch(() => null);
  }
  return clackPromise;
};

export const intro = async (message: string): Promise<void> => {
  const clack = await loadClack();
  if (clack) clack.intro(message);
  else console.log(`\n${message}`);
};

const QUIVER_ART = [
  "  ___        _                 ",
  " / _ \\ _   _(_)_   _____ _ __  ",
  "| | | | | | | \\ \\ / / _ \\ '__| ",
  "| |_| | |_| | |\\ V /  __/ |    ",
  " \\__\\_\\\\__,_|_| \\_/ \\___|_|    ",
];

const TAGLINE =
  "Compose skills, commands & MCP servers into any repo — lockfile-based drift awareness.";

const colorEnabled = (): boolean =>
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

// Minimal ANSI palette, auto-disabled for non-TTY / NO_COLOR. Lets commands
// render compact custom output (tables, lists) outside the clack box style.
export interface Palette {
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
}

export const palette = (): Palette => {
  const on = colorEnabled();
  const wrap = (code: string) => (s: string) =>
    on ? `\x1b[${code}m${s}\x1b[0m` : s;
  return {
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
    dim: wrap("2"),
    bold: wrap("1"),
    red: wrap("31"),
  };
};

// Print a pre-formatted block in one go (no clack box framing).
export const block = (lines: string[]): void => {
  console.log(lines.join("\n"));
};

// Large multi-line intro banner for `init`. Plain text when color is disabled
// (non-TTY or NO_COLOR), so piped/CI output stays clean.
export const banner = async (): Promise<void> => {
  const color = colorEnabled();
  const cyan = color ? "\x1b[36m" : "";
  const dim = color ? "\x1b[2m" : "";
  const reset = color ? "\x1b[0m" : "";

  console.log("");
  for (const line of QUIVER_ART) {
    console.log(`${cyan}${line}${reset}`);
  }
  console.log("");
  console.log(`${dim}${TAGLINE}${reset}`);
  console.log("");
};

export const outro = async (message: string): Promise<void> => {
  const clack = await loadClack();
  if (clack) clack.outro(message);
  else console.log(`\n${message}\n`);
};

export const step = async (message: string): Promise<void> => {
  const clack = await loadClack();
  if (clack) clack.log.step(message);
  else console.log(`  ${message}`);
};

export const info = async (message: string): Promise<void> => {
  const clack = await loadClack();
  if (clack) clack.log.info(message);
  else console.log(`  ${message}`);
};

export const success = async (message: string): Promise<void> => {
  const clack = await loadClack();
  if (clack) clack.log.success(message);
  else console.log(`  ${message}`);
};

export const warn = async (message: string): Promise<void> => {
  const clack = await loadClack();
  if (clack) clack.log.warn(message);
  else console.warn(`  ${message}`);
};

export const error = async (message: string): Promise<void> => {
  const clack = await loadClack();
  if (clack) clack.log.error(message);
  else console.error(message);
};

// Masked text input. Returns null on cancel. Falls back to a plain readline
// question (input visible) when clack is unavailable.
export const password = async (message: string): Promise<string | null> => {
  const clack = await loadClack();
  if (clack) {
    const value = await clack.password({ message });
    if (clack.isCancel(value)) return null;
    return value;
  }
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => {
    rl.question(`${message}: `, (a) => {
      rl.close();
      res(a);
    });
  });
  return answer.trim() || null;
};

export interface Spinner {
  start: (message: string) => void;
  stop: (message: string) => void;
}

export const spinner = async (): Promise<Spinner> => {
  const clack = await loadClack();
  if (clack) {
    const s = clack.spinner();
    return {
      start: (message: string) => s.start(message),
      stop: (message: string) => s.stop(message),
    };
  }
  return {
    start: (message: string) => console.log(`  ${message}`),
    stop: (message: string) => console.log(`  ${message}`),
  };
};

export interface SelectGroup<T extends string = string> {
  name: string;
  items: { value: T; label: string; hint?: string }[];
}

// Grouped multiselect with a plain-readline fallback when clack is unavailable.
// Returns the selected values, or exits the process on cancel.
export const selectGrouped = async <T extends string>({
  message,
  groups,
  initialValues,
}: {
  message: string;
  groups: SelectGroup<T>[];
  initialValues: T[];
}): Promise<T[]> => {
  const clack = await loadClack();
  if (clack) {
    const options: Record<string, { value: T; label: string; hint?: string }[]> =
      {};
    for (const group of groups) {
      options[group.name] = group.items.map((i) => ({
        value: i.value,
        label: i.label,
        ...(i.hint !== undefined ? { hint: i.hint } : {}),
      }));
    }
    const selected = await clack.groupMultiselect<T>({
      message,
      // clack's Option<T> is structurally compatible; the Record index
      // signature is invariant so an explicit cast is required here.
      options: options as Parameters<typeof clack.groupMultiselect<T>>[0]["options"],
      initialValues,
      required: false,
      selectableGroups: false,
    });
    if (clack.isCancel(selected)) {
      clack.cancel("Cancelled - no changes made.");
      process.exit(0);
    }
    return selected as T[];
  }
  return selectGroupedText({ message, groups, initialValues });
};

const selectGroupedText = async <T extends string>({
  message,
  groups,
  initialValues,
}: {
  message: string;
  groups: SelectGroup<T>[];
  initialValues: T[];
}): Promise<T[]> => {
  const { createInterface } = await import("node:readline");
  const flat = groups.flatMap((g) => g.items.map((i) => i.value));
  console.log(`\n${message}`);
  let index = 0;
  for (const group of groups) {
    console.log(`  ${group.name}`);
    for (const item of group.items) {
      index += 1;
      const mark = initialValues.includes(item.value) ? "*" : " ";
      const hint = item.hint ? `  (${item.hint})` : "";
      console.log(`    ${index}) [${mark}] ${item.label}${hint}`);
    }
  }
  const preselected = flat
    .map((v, i) => (initialValues.includes(v) ? i + 1 : null))
    .filter((n): n is number => n !== null)
    .join(",");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => {
    rl.question(
      `\nEnter numbers (comma-separated), 'all', or 'none' [${preselected || "none"}]: `,
      (a) => {
        rl.close();
        res(a);
      },
    );
  });
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "all" || trimmed === "a") return flat;
  if (trimmed === "none" || trimmed === "n") return [];
  if (trimmed === "") return flat.filter((v) => initialValues.includes(v));
  const picked = new Set<T>();
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const n = Number.parseInt(token, 10);
    if (Number.isInteger(n) && n >= 1 && n <= flat.length) {
      picked.add(flat[n - 1]!);
    }
  }
  return [...picked];
};
