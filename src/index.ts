#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, setConfig, store } from "./server.js";
import { AppConfig, DEFAULT_CONFIG } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { assignFingerprints } from "./engine/clustering.js";

/**
 * Load optional configuration from log-intelligence.config.json in CWD.
 */
async function loadConfig(): Promise<AppConfig> {
  const configPath = resolve(process.cwd(), "log-intelligence.config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      sources: parsed.sources ?? [],
      defaults: {
        bucketMinutes: parsed.defaults?.bucketMinutes ?? DEFAULT_CONFIG.defaults.bucketMinutes,
        anomalyThreshold: parsed.defaults?.anomalyThreshold ?? DEFAULT_CONFIG.defaults.anomalyThreshold,
        maxSamples: parsed.defaults?.maxSamples ?? DEFAULT_CONFIG.defaults.maxSamples,
      },
    };
  } catch {
    // No config file or invalid — use defaults
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Pre-ingest any sources defined in the config file.
 */
async function preIngest(config: AppConfig): Promise<void> {
  for (const sourceConfig of config.sources) {
    try {
      const adapter = getAdapter(sourceConfig.type);
      const entries = await adapter.ingest(sourceConfig);
      assignFingerprints(entries);
      store.add(entries);
      console.error(
        `[log-intelligence-mcp] Pre-ingested ${entries.length} entries from "${sourceConfig.name}" (${sourceConfig.type})`
      );
    } catch (err) {
      console.error(
        `[log-intelligence-mcp] Failed to pre-ingest "${sourceConfig.name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  // Load config
  const appConfig = await loadConfig();
  setConfig(appConfig);

  // Pre-ingest configured sources
  if (appConfig.sources.length > 0) {
    await preIngest(appConfig);
  }

  // Create MCP server and connect via stdio
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[log-intelligence-mcp] Server started on stdio transport");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.error("[log-intelligence-mcp] Shutting down...");
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("[log-intelligence-mcp] Shutting down...");
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[log-intelligence-mcp] Fatal error:", err);
  process.exit(1);
});
