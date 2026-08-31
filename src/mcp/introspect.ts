import type { McpServer } from "../catalog/discover.js";

export interface IntrospectedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type IntrospectResult =
  | { ok: true; tools: IntrospectedTool[] }
  | { ok: false; reason: string; authRequired?: boolean };

const CONNECT_TIMEOUT_MS = 15000;

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
};

// Connect to an MCP server and return its tools/list. HTTP servers connect
// directly; stdio servers run foreign code and are gated behind allowStdio.
export const introspect = async (
  server: McpServer,
  { allowStdio, authToken }: { allowStdio: boolean; authToken?: string },
): Promise<IntrospectResult> => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  let transport;
  try {
    if (server.transport === "http") {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const headers: Record<string, string> = { ...(server.headers ?? {}) };
      // Configured headers win; only inject the OAuth token when the config
      // does not set its own Authorization header.
      const hasAuthHeader = Object.keys(headers).some(
        (k) => k.toLowerCase() === "authorization",
      );
      if (authToken && !hasAuthHeader) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }
      const requestInit: RequestInit = Object.keys(headers).length
        ? { headers }
        : {};
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit,
      });
    } else {
      if (!allowStdio) {
        return {
          ok: false,
          reason: "stdio server skipped (pass --introspect-stdio to run it)",
        };
      }
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
      });
    }
  } catch (e) {
    return { ok: false, reason: `transport error: ${errMsg(e)}` };
  }

  const client = new Client(
    { name: "quiver", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS);
    const res = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS);
    const tools: IntrospectedTool[] = (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
    return { ok: true, tools };
  } catch (e) {
    if (await isAuthError(e)) {
      return { ok: false, reason: errMsg(e), authRequired: true };
    }
    return { ok: false, reason: errMsg(e) };
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
};

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// Detect "needs OAuth" failures. The SDK surfaces 401s in several shapes:
// UnauthorizedError, StreamableHTTPError with code 401 (message omits the
// status), or plain errors mentioning 401/unauthorized/invalid_token.
export const isAuthError = async (e: unknown): Promise<boolean> => {
  try {
    const { UnauthorizedError } = await import(
      "@modelcontextprotocol/sdk/client/auth.js"
    );
    if (e instanceof UnauthorizedError) return true;
  } catch {
    /* fall through to shape/message heuristics */
  }
  if (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === 401
  ) {
    return true;
  }
  return /\b401\b|unauthorized|invalid_token/i.test(errMsg(e));
};
