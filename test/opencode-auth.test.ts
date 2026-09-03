import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findOpencodeToken } from "../src/mcp/opencode-auth.js";
import { isAuthError } from "../src/mcp/introspect.js";

const FUTURE_S = Math.floor(Date.now() / 1000) + 3600;
const PAST_S = Math.floor(Date.now() / 1000) - 3600;

describe("findOpencodeToken", () => {
  let dataDir: string;
  const originalXdg = process.env["XDG_DATA_HOME"];

  const writeAuthFile = (data: unknown): void => {
    const dir = join(dataDir, "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp-auth.json"), JSON.stringify(data));
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "quiver-oauth-"));
    process.env["XDG_DATA_HOME"] = dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (originalXdg === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = originalXdg;
  });

  it("returns none when the auth file is missing", () => {
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "none",
    });
  });

  it("matches by server URL regardless of the entry key", () => {
    writeAuthFile({
      "some-other-name": {
        serverUrl: "https://mcp.linear.app/mcp",
        tokens: { accessToken: "tok-1", expiresAt: FUTURE_S },
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "ok",
      accessToken: "tok-1",
    });
  });

  it("normalizes trailing slashes and case when matching URLs", () => {
    writeAuthFile({
      linear: {
        serverUrl: "https://MCP.linear.app/mcp/",
        tokens: { accessToken: "tok-2", expiresAt: FUTURE_S },
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "ok",
      accessToken: "tok-2",
    });
  });

  it("returns none when the named entry has a different server URL", () => {
    writeAuthFile({
      linear: {
        serverUrl: "https://different.example.com/mcp",
        tokens: { accessToken: "tok-3", expiresAt: FUTURE_S },
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "none",
    });
  });

  it("falls back to matching legacy entries by server name", () => {
    writeAuthFile({
      linear: {
        tokens: { accessToken: "tok-legacy", expiresAt: FUTURE_S },
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "ok",
      accessToken: "tok-legacy",
    });
  });

  it("reports expired tokens from legacy name fallback", () => {
    writeAuthFile({
      linear: {
        tokens: { accessToken: "tok-legacy-expired", expiresAt: PAST_S },
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "expired",
    });
  });

  it("reports expired tokens (epoch seconds)", () => {
    writeAuthFile({
      linear: {
        serverUrl: "https://mcp.linear.app/mcp",
        tokens: { accessToken: "tok-4", expiresAt: PAST_S },
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "expired",
    });
  });

  it("handles millisecond expiry timestamps defensively", () => {
    writeAuthFile({
      linear: {
        serverUrl: "https://mcp.linear.app/mcp",
        tokens: { accessToken: "tok-5", expiresAt: Date.now() + 3600_000 },
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "ok",
      accessToken: "tok-5",
    });
  });

  it("treats entries without tokens as none (pending auth flow)", () => {
    writeAuthFile({
      linear: {
        serverUrl: "https://mcp.linear.app/mcp",
        clientInfo: { clientId: "abc" },
        codeVerifier: "xyz",
      },
    });
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "none",
    });
  });

  it("returns none on malformed JSON", () => {
    const dir = join(dataDir, "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp-auth.json"), "{not json");
    expect(findOpencodeToken("linear", "https://mcp.linear.app/mcp")).toEqual({
      status: "none",
    });
  });
});

describe("isAuthError", () => {
  it("detects HTTP 401 in error messages", async () => {
    expect(await isAuthError(new Error("Error POSTing to endpoint (HTTP 401)"))).toBe(true);
  });

  it("detects unauthorized messages", async () => {
    expect(await isAuthError(new Error("Unauthorized"))).toBe(true);
  });

  it("detects the SDK UnauthorizedError", async () => {
    const { UnauthorizedError } = await import(
      "@modelcontextprotocol/sdk/client/auth.js"
    );
    expect(await isAuthError(new UnauthorizedError())).toBe(true);
  });

  it("detects StreamableHTTPError-style errors via code 401", async () => {
    const e = Object.assign(
      new Error("Streamable HTTP error: Error POSTing to endpoint: ..."),
      { code: 401 },
    );
    expect(await isAuthError(e)).toBe(true);
  });

  it("detects invalid_token error bodies", async () => {
    expect(
      await isAuthError(
        new Error('Error POSTing to endpoint: {"error":"invalid_token"}'),
      ),
    ).toBe(true);
  });

  it("ignores unrelated errors", async () => {
    expect(await isAuthError(new Error("timed out after 15000ms"))).toBe(false);
    expect(await isAuthError(new Error("HTTP 500 internal error"))).toBe(false);
  });
});
