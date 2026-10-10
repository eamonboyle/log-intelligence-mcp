import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { credentialsForEndpoint } from "../adapters/elastic.js";
import { ingestSource } from "../ingest.js";
import { ADAPTER_TYPES, SourceConfig } from "../types.js";
import { SourceInfoJsonSchema, sourceInfoToJson, plural } from "../format.js";
import { ServerContext, guard, textResult } from "./common.js";

export function registerSourceTools(server: McpServer, ctx: ServerContext): void {
  // ─── ingest_logs ────────────────────────────────────────────────────────
  server.registerTool(
    "ingest_logs",
    {
      title: "Ingest logs",
      description:
        "Ingest log entries from a data source (Serilog CLEF/JSON, Elasticsearch dump or live endpoint, SQLite database, or flat text file). " +
        "Re-ingesting a source with the same name replaces its previous entries unless mode is \"append\".",
      inputSchema: {
        source: z.enum(ADAPTER_TYPES).describe("Log source adapter type"),
        path: z.string().optional().describe("File path to the log file or database (not needed for live Elasticsearch)"),
        name: z.string().optional().describe("Friendly name for this source (defaults to path or endpoint)"),
        mode: z.enum(["replace", "append"]).optional().describe("replace (default) drops earlier entries from a source with the same name; append keeps them"),
        table: z.string().optional().describe("Table name for the sql adapter (default Logs)"),
        filter: z.string().optional().describe("Filter: SQL WHERE clause for sql, query_string for elastic"),
        pattern: z.string().optional().describe("Custom regex for flatfile with groups (timestamp)(level)(message) or named groups"),
        endpoint: z
          .string()
          .optional()
          .describe(
            "Elasticsearch base URL for live queries, e.g. http://localhost:9200. Credentials are only sent if it matches a configured source or ELASTIC_URL"
          ),
        index: z.string().optional().describe("Elasticsearch index name or pattern (default *)"),
        limit: z.number().int().positive().optional().describe("Max documents to fetch from live Elasticsearch (default and max 10000)"),
      },
      outputSchema: {
        source: z.string(),
        type: z.string(),
        ingested: z.number(),
        errors: z.number(),
        skipped: z.number(),
        replaced: z.number(),
        totalInStore: z.number(),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const sourceConfig: SourceConfig = {
        name: args.name || args.path || args.endpoint || args.source,
        type: args.source,
        path: args.path,
        table: args.table,
        filter: args.filter,
        pattern: args.pattern,
        endpoint: args.endpoint,
        index: args.index,
        limit: args.limit,
        ...(args.endpoint ? credentialsForEndpoint(args.endpoint, ctx.config.sources) : {}),
      };

      const outcome = await ingestSource(ctx.store, sourceConfig, args.mode ?? "replace");
      const { result } = outcome;

      const lines = [
        `Ingested ${plural(result.entries.length, "entry", "entries")} from "${sourceConfig.name}" (${args.source} adapter).`,
        `  - Errors/Fatal: ${outcome.errorCount}`,
        `  - Skipped (unparseable): ${result.skipped}`,
      ];
      if (outcome.replaced > 0) lines.push(`  - Replaced ${outcome.replaced} earlier entries from the same source`);
      lines.push(`  - Total entries in store: ${ctx.store.size}`);
      for (const w of result.warnings) lines.push(`  ! ${w}`);

      return textResult(lines.join("\n"), {
        source: sourceConfig.name,
        type: args.source,
        ingested: result.entries.length,
        errors: outcome.errorCount,
        skipped: result.skipped,
        replaced: outcome.replaced,
        totalInStore: ctx.store.size,
        warnings: result.warnings,
      });
    })
  );

  // ─── list_sources ───────────────────────────────────────────────────────
  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description: "List all ingested log sources with entry counts, error counts and time ranges.",
      inputSchema: {},
      outputSchema: {
        sources: z.array(SourceInfoJsonSchema),
        totalEntries: z.number(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async () => {
      const sources = ctx.store.getSourceInfo();
      if (sources.length === 0) {
        return textResult("No logs ingested yet. Use ingest_logs to load data.", { sources: [], totalEntries: 0 });
      }

      const lines = [`${plural(sources.length, "source")}, ${plural(ctx.store.size, "entry", "entries")} total:`, ""];
      for (const s of sources) {
        const range = s.timeRange ? `${s.timeRange.earliest.toISOString()} → ${s.timeRange.latest.toISOString()}` : "no entries";
        lines.push(`- ${s.name} (${s.type}): ${s.entryCount} entries, ${s.errorCount} errors, ${range}`);
      }

      return textResult(lines.join("\n"), {
        sources: sources.map(sourceInfoToJson),
        totalEntries: ctx.store.size,
      });
    })
  );

  // ─── clear_logs ─────────────────────────────────────────────────────────
  server.registerTool(
    "clear_logs",
    {
      title: "Clear logs",
      description: "Remove ingested log entries from memory: a single source by name, or everything when no source is given.",
      inputSchema: {
        source: z.string().optional().describe("Exact source name to remove. Omit to clear all sources."),
      },
      outputSchema: {
        removed: z.number(),
        remaining: z.number(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      if (args.source) {
        if (!ctx.store.hasSource(args.source)) {
          const known = ctx.store.getSourceInfo().map((s) => s.name);
          return textResult(
            `No source named "${args.source}". Known sources: ${known.length ? known.join(", ") : "(none)"}`,
            { removed: 0, remaining: ctx.store.size }
          );
        }
        const removed = ctx.store.removeSource(args.source);
        return textResult(`Removed ${plural(removed, "entry", "entries")} from "${args.source}". ${ctx.store.size} remaining.`, {
          removed,
          remaining: ctx.store.size,
        });
      }

      const removed = ctx.store.size;
      ctx.store.clear();
      return textResult(`Cleared all ${plural(removed, "entry", "entries")} from the store.`, { removed, remaining: 0 });
    })
  );
}
