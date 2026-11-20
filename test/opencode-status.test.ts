import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readOpencodeStatuses } from "../src/mcp/opencode-status.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const directory = realpathSync(process.cwd());
const data = [{ name: "alpha", status: { status: "connected" } }];

describe("OpenCode 2.3.2 status response", () => {
  it("scopes the bounded, noninteractive query and reads only the named server status", () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ location: { directory }, data }));
    expect([...readOpencodeStatuses(directory)]).toEqual([["alpha", "connected"]]);
    expect(execFileSync).toHaveBeenCalledWith("opencode", ["api", "get", `/api/mcp?${new URLSearchParams({ "location[directory]": directory })}`],
      expect.objectContaining({ cwd: directory, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }));
  });

  it.each([JSON.stringify({ location: { directory: directory + "-other" }, data }), JSON.stringify(data), "not JSON"])("ignores unscoped, mismatched or malformed status", (output) => {
    vi.mocked(execFileSync).mockReturnValue(output);
    expect(readOpencodeStatuses(directory).size).toBe(0);
  });
});
