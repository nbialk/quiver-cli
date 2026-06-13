import type { CliOptions } from "../cli.js";
import { authFilePath, deleteStoredToken } from "../github/auth.js";
import * as ui from "../ui/prompts.js";

// Remove the GitHub token stored by `quiver-cli login`.
export const logout = async (options: CliOptions): Promise<void> => {
  const removed = deleteStoredToken();
  if (options.json) {
    console.log(JSON.stringify({ ok: true, removed }, null, 2));
    return;
  }
  if (removed) {
    await ui.success(`Logged out. Removed ${authFilePath()}.`);
  } else {
    await ui.info("Not logged in - nothing to remove.");
  }
};
