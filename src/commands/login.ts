import type { CliOptions } from "../cli.js";
import * as ui from "../ui/prompts.js";

export const login = async (_options: CliOptions): Promise<void> => {
  await ui.info("login is not available yet (remote catalogs land in a later phase).");
};
