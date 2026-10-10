import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServerContext } from "./common.js";
import { registerSourceTools } from "./sources.js";
import { registerErrorTools } from "./errors.js";
import { registerRegressionTools } from "./regression.js";
import { registerSearchTools } from "./search.js";
import { registerTimelineTools } from "./timeline.js";

export type { ServerContext } from "./common.js";

export function registerTools(server: McpServer, ctx: ServerContext): void {
  registerSourceTools(server, ctx);
  registerErrorTools(server, ctx);
  registerRegressionTools(server, ctx);
  registerSearchTools(server, ctx);
  registerTimelineTools(server, ctx);
}
