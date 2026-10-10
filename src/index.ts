#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { ingestSource } from "./ingest.js";
import { createContext, createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { ServerContext } from "./tools/index.js";

const log = (msg: string) => console.error(`[${SERVER_NAME}] ${msg}`);

function printHelp(): void {
  console.log(`${SERVER_NAME} ${SERVER_VERSION}

MCP server that ingests structured logs and surfaces error clusters, anomalies and regressions.
Speaks MCP over stdio; point your MCP client at this executable.

Usage: ${SERVER_NAME} [options]

Options:
  -c, --config <path>  Config file (default: ./log-intelligence.config.json, or $LOG_INTELLIGENCE_CONFIG)
  -v, --version        Print the version and exit
  -h, --help           Show this help
`);
}

/**
 * Pre-ingest any sources defined in the config file.
 */
async function preIngest(ctx: ServerContext): Promise<void> {
  for (const sourceConfig of ctx.config.sources) {
    try {
      const outcome = await ingestSource(ctx.store, sourceConfig);
      log(`Pre-ingested ${outcome.result.entries.length} entries from "${sourceConfig.name}" (${sourceConfig.type})`);
      for (const w of outcome.result.warnings) log(`  warning: ${w}`);
    } catch (err) {
      log(`Failed to pre-ingest "${sourceConfig.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }
  if (values.version) {
    console.log(SERVER_VERSION);
    return;
  }

  const loaded = await loadConfig(values.config);
  for (const w of loaded.warnings) log(`warning: ${w}`);
  if (loaded.path) log(`Loaded config from ${loaded.path}`);

  const ctx = createContext(loaded.config);
  if (ctx.config.sources.length > 0) {
    await preIngest(ctx);
  }

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${SERVER_VERSION} started on stdio transport`);

  const shutdown = async (signal: string) => {
    log(`Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
