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
// non-interactive. Invalid explicit values are reported by the CLI.
export const resolveProviders = async (
  options: CliOptions,
): Promise<Provider[]> => {
  if (options.providers) {
    const { providers, invalid } = validateProviders(options.providers);
    if (invalid) {
      throw new Error(
        `Unknown provider(s): ${invalid.map((value) => value || "(empty)").join(", ")}. Valid: ${PROVIDERS.join(", ")}.`,
      );
    }
    if (!providers?.length) throw new Error("At least one provider is required.");
    return providers;
  }

  if (options.all || options.yes || options.json || options.empty || !process.stdin.isTTY) {
    return [...PROVIDERS];
  }

  return selectProviders([...PROVIDERS]);
};

// Interactive provider multiselect, pre-filled with the given current values.
// Falls back to the supplied defaults when nothing is picked.
export const selectProviders = async (
  initialValues: Provider[],
): Promise<Provider[]> => {
  if (!process.stdin.isTTY) return initialValues;
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
