import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LogStore } from "./engine/store.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools, ServerContext } from "./tools/index.js";
import { AppConfig, DEFAULT_CONFIG } from "./types.js";

export type { ServerContext } from "./tools/index.js";

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

export const SERVER_NAME = pkg.name;
export const SERVER_VERSION = pkg.version;

/** Build an isolated store + config pair. */
export function createContext(config: AppConfig = structuredClone(DEFAULT_CONFIG)): ServerContext {
  return { store: new LogStore(), config };
}

/**
 * Create a fully configured MCP server over the given context. The context is
 * passed in (rather than held in module state) so several servers can coexist
 * in one process, which keeps tests independent of each other.
 */
export function createServer(ctx: ServerContext = createContext()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
        prompts: {},
        completions: {},
      },
      instructions:
        "Log analysis server. Start with ingest_logs (or list_sources if sources were pre-configured), " +
        "then summarise_errors for the big picture, get_error_timeline with detectAnomalies for spikes, " +
        "regression_after_date to evaluate a deployment, and get_log_context / search_logs to drill into specific events.",
    }
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);

  return server;
}
