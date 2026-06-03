// Thin UI layer over @clack/prompts with graceful console fallbacks.
//
// clack is loaded lazily and cached. If it can't be loaded (e.g. the dependency
// failed to install during `npx github:...`), every helper degrades to plain
// console output so the CLI keeps working.

let clackPromise;

export const loadClack = async () => {
  if (clackPromise === undefined) {
    clackPromise = import("@clack/prompts").catch(() => null);
  }
  return clackPromise;
};

export const intro = async (message) => {
  const clack = await loadClack();
  if (clack) clack.intro(message);
  else console.log(`\n${message}`);
};

export const outro = async (message) => {
  const clack = await loadClack();
  if (clack) clack.outro(message);
  else console.log(`\n${message}\n`);
};

export const step = async (message) => {
  const clack = await loadClack();
  if (clack) clack.log.step(message);
  else console.log(`  ${message}`);
};

export const info = async (message) => {
  const clack = await loadClack();
  if (clack) clack.log.info(message);
  else console.log(`  ${message}`);
};

export const success = async (message) => {
  const clack = await loadClack();
  if (clack) clack.log.success(message);
  else console.log(`  ${message}`);
};

export const warn = async (message) => {
  const clack = await loadClack();
  if (clack) clack.log.warn(message);
  else console.warn(`  ${message}`);
};

export const error = async (message) => {
  const clack = await loadClack();
  if (clack) clack.log.error(message);
  else console.error(message);
};

// Returns a spinner-like handle. Falls back to a single line when clack is
// unavailable, so callers can always call start()/stop().
export const spinner = async () => {
  const clack = await loadClack();
  if (clack) {
    const s = clack.spinner();
    return {
      start: (message) => s.start(message),
      stop: (message) => s.stop(message),
    };
  }
  return {
    start: (message) => console.log(`  ${message}`),
    stop: (message) => console.log(`  ${message}`),
  };
};
