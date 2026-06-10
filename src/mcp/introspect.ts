import type { McpServer } from "../catalog/discover.js";

export interface IntrospectedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type IntrospectResult =
  | { ok: true; tools: IntrospectedTool[] }
  | { ok: false; reason: string };

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
  { allowStdio }: { allowStdio: boolean },
): Promise<IntrospectResult> => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  let transport;
  try {
    if (server.transport === "http") {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const requestInit: RequestInit = server.headers
        ? { headers: server.headers }
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
