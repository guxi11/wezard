// MCP server `wezard` — stdio entry point. Dist path is load-bearing: every live
// pane's MCP config runs `node dist/mcp/server.js`; the tool surface itself is
// mcp/tools.ts, and the daemon's in-process http entry is daemon/mcp-http.ts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWezardServer } from "./tools.js";

const server = createWezardServer();
const transport = new StdioServerTransport();
await server.connect(transport);
