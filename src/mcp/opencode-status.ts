import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

// OpenCode 2.3.2 GET /api/mcp exposes status, not tools/list. Query once per
// project, only with opt-in: opening a location can start plugins and servers.
export const readOpencodeStatuses = (root: string): Map<string, string> => {
  const statuses = new Map<string, string>();
  try {
    const directory = realpathSync(root);
    const path = `/api/mcp?${new URLSearchParams({ "location[directory]": directory })}`;
    const output = execFileSync("opencode", ["api", "get", path], {
      cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(output);
    if (result?.location?.directory !== directory || !Array.isArray(result.data)) return statuses;
    for (const row of result.data) {
      if (typeof row?.name === "string" && typeof row.status?.status === "string") {
        statuses.set(row.name, row.status.status);
      }
    }
  } catch {
    // Missing CLI, V1, timeout, or invalid output: no V2 observation.
  }
  return statuses;
};
