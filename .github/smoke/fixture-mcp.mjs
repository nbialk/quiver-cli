import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

await new McpServer({ name: 'quiver-fixture', version: '1' }).connect(new StdioServerTransport());
