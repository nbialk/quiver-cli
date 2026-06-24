import type { CliOptions } from "../cli.js";
import { isProvider, PROVIDERS, type Provider } from "../lockfile/schema.js";
import * as ui from "../ui/prompts.js";

export interface ProviderValidation {
  /** Valid, de-duplicated providers (only present when invalid is empty). */
  providers?: Provider[];
  /** Unknown values encountered, preserving input order. */
  invalid?: string[];
}

// Pure validation against the known PROVIDERS. De-duplicates valid entries
// while preserving order; reports every unknown value so callers can list them.
export const validateProviders = (values: string[]): ProviderValidation => {
  const invalid = values.filter((v) => !isProvider(v));
  if (invalid.length) return { invalid };
  const seen = new Set<Provider>();
  const providers: Provider[] = [];
  for (const v of values) {
    if (isProvider(v) && !seen.has(v)) {
      seen.add(v);
      providers.push(v);
    }
  }
  return { providers };
};

// Whether two provider lists describe the same set (order-insensitive).
export const sameProviders = (a: Provider[], b: Provider[]): boolean =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

// Resolve target providers for init: --providers= flag wins, then an
// interactive multiselect (default: all), falling back to all when
// non-interactive. Returns null when the flag contains invalid values
// (error already shown).
export const resolveProviders = async (
  options: CliOptions,
): Promise<Provider[] | null> => {
  if (options.providers) {
    const { providers, invalid } = validateProviders(options.providers);
    if (invalid) {
      await ui.error(
        `Unknown provider(s): ${invalid.join(", ")}. Valid: ${PROVIDERS.join(", ")}.`,
      );
      process.exitCode = 1;
      return null;
    }
    return providers!;
  }

  if (options.all || !process.stdin.isTTY) return [...PROVIDERS];

  return selectProviders([...PROVIDERS]);
};

// Interactive provider multiselect, pre-filled with the given current values.
// Falls back to the supplied defaults when nothing is picked.
export const selectProviders = async (
  initialValues: Provider[],
): Promise<Provider[]> => {
  const picked = await ui.selectGrouped<Provider>({
    message: "Generate configs for (space toggles, enter confirms)",
    groups: [
      {
        name: "providers",
        items: [
          { value: "claude", label: "Claude Code" },
          { value: "opencode", label: "opencode" },
          { value: "codex", label: "Codex" },
        ],
      },
    ],
    initialValues,
  });
  return picked.length ? picked : initialValues;
};
