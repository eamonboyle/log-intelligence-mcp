import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clusterErrors } from "./engine/clustering.js";
import { clusterToJson, sourceInfoToJson } from "./format.js";
import { ServerContext } from "./tools/common.js";

function json(uri: URL, value: unknown) {
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  };
}

export function registerResources(server: McpServer, ctx: ServerContext): void {
  // logs://sources
  server.registerResource(
    "log-sources",
    "logs://sources",
    {
      title: "Log sources",
      description: "All ingested log sources with entry counts, error counts and time ranges",
      mimeType: "application/json",
    },
    async (uri) => {
      const sources = ctx.store.getSourceInfo();
      if (sources.length === 0) {
        return json(uri, { sources: [], message: "No logs ingested yet. Use ingest_logs to load data." });
      }
      return json(uri, { sources: sources.map(sourceInfoToJson) });
    }
  );

  // logs://summary
  server.registerResource(
    "log-summary",
    "logs://summary",
    {
      title: "Log summary",
      description: "Current log store stats: total entries, error count, unique error patterns, time range",
      mimeType: "application/json",
    },
    async (uri) => {
      const summary = ctx.store.getSummary();
      const clusters = clusterErrors(ctx.store.all(), 1);
      return json(uri, {
        totalEntries: summary.totalEntries,
        errorCount: summary.errorCount,
        uniqueSources: summary.uniqueSources,
        uniqueErrorPatterns: clusters.length,
        timeRange: summary.timeRange
          ? { earliest: summary.timeRange.earliest.toISOString(), latest: summary.timeRange.latest.toISOString() }
          : null,
      });
    }
  );

  // logs://cluster/{fingerprint}
  server.registerResource(
    "error-cluster",
    new ResourceTemplate("logs://cluster/{fingerprint}", {
      list: undefined,
      complete: {
        fingerprint: (value) =>
          clusterErrors(ctx.store.all(), 1)
            .map((c) => c.fingerprint)
            .filter((fp) => fp.startsWith(value))
            .slice(0, 20),
      },
    }),
    {
      title: "Error cluster",
      description: "Details and sample entries for one error fingerprint",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const fp = String(variables.fingerprint);
      const entries = ctx.store.errors({ fingerprint: fp });
      if (entries.length === 0) {
        return json(uri, { fingerprint: fp, message: "No error entries with this fingerprint." });
      }
      const [cluster] = clusterErrors(entries, Math.max(ctx.config.defaults.maxSamples, 10));
      return json(uri, clusterToJson(cluster));
    }
  );
}
