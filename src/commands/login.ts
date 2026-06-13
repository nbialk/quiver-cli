import process from "node:process";

import type { CliOptions } from "../cli.js";
import { authFilePath, validateToken, writeStoredToken } from "../github/auth.js";
import * as ui from "../ui/prompts.js";

// Store a GitHub personal access token for remote (github:) catalogs.
// Interactive: masked prompt. Non-interactive: token is read from stdin
// (e.g. `gh auth token | quiver-cli login`).
export const login = async (options: CliOptions): Promise<void> => {
  const token = process.stdin.isTTY ? await promptToken() : await readStdin();
  if (!token) {
    await ui.error(
      "No token provided. Create a GitHub personal access token with `repo` read access and try again.",
    );
    process.exitCode = 1;
    return;
  }

  const validation = await validateToken(token);
  if (!validation.ok) {
    await ui.error(`Token validation failed: ${validation.reason}`);
    process.exitCode = 1;
    return;
  }

  writeStoredToken(token, validation.login);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, login: validation.login }, null, 2));
    return;
  }
  await ui.success(
    `Logged in as ${validation.login}. Token stored in ${authFilePath()}.`,
  );
};

const promptToken = async (): Promise<string | null> => {
  await ui.info(
    "Paste a GitHub personal access token (used for github: catalogs; needs read access to the catalog repo).",
  );
  const value = await ui.password("GitHub token");
  return value?.trim() || null;
};

const readStdin = async (): Promise<string | null> => {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() || null;
};
