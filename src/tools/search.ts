import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EntryJsonSchema, entryToJson, formatEntry, plural } from "../format.js";
import { parseDateArg, requireDateArg } from "../util/time.js";
import { ServerContext, guard, isoDate, levelSchema, optionalIsoDate, sourceFilter, textResult } from "./common.js";

export function registerSearchTools(server: McpServer, ctx: ServerContext): void {
  // ─── search_logs ────────────────────────────────────────────────────────
  server.registerTool(
    "search_logs",
    {
      title: "Search logs",
      description: "Search message and exception text across all ingested entries. Case-insensitive substring match by default, or a regular expression.",
      inputSchema: {
        query: z.string().min(1).describe("Search term or regular expression"),
        regex: z.boolean().optional().describe("Interpret query as a regular expression (default false)"),
        level: levelSchema.optional().describe("Filter by log level"),
        source: sourceFilter,
        fingerprint: z.string().optional().describe("Restrict to entries with this fingerprint"),
        startDate: optionalIsoDate("Start of time range"),
        endDate: optionalIsoDate("End of time range"),
        limit: z.number().int().positive().optional().describe("Max results to return (default 50)"),
      },
      outputSchema: {
        query: z.string(),
        total: z.number().describe("Total matches before applying limit"),
        returned: z.number(),
        entries: z.array(EntryJsonSchema),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      const limit = args.limit ?? 50;
      const all = ctx.store.query({
        search: args.query,
        regex: args.regex,
        level: args.level,
        source: args.source,
        fingerprint: args.fingerprint,
        startDate: parseDateArg(args.startDate, "startDate"),
        endDate: parseDateArg(args.endDate, "endDate"),
      });
      const results = all.slice(0, limit);

      if (results.length === 0) {
        return textResult(`No log entries found matching "${args.query}".`, {
          query: args.query,
          total: 0,
          returned: 0,
          entries: [],
        });
      }

      const header =
        all.length > results.length
          ? `Found ${plural(all.length, "entry", "entries")} matching "${args.query}" (showing first ${results.length}):`
          : `Found ${plural(all.length, "entry", "entries")} matching "${args.query}":`;
      const lines = [header, ""];
      for (const e of results) lines.push(...formatEntry(e));

      return textResult(lines.join("\n"), {
        query: args.query,
        total: all.length,
        returned: results.length,
        entries: results.map(entryToJson),
      });
    })
  );

  // ─── get_log_context ────────────────────────────────────────────────────
  server.registerTool(
    "get_log_context",
    {
      title: "Log context",
      description:
        "Show the log entries immediately before and after a point in time, across all levels. Use it to see what led up to an error and what happened next.",
      inputSchema: {
        timestamp: isoDate("Point in time to centre on (e.g. an error's timestamp)"),
        before: z.number().int().min(0).optional().describe("Entries to show before the timestamp (default 10)"),
        after: z.number().int().min(0).optional().describe("Entries to show after the timestamp (default 10)"),
        source: sourceFilter,
        minLevel: levelSchema.optional().describe("Hide entries below this level (default trace, i.e. show everything)"),
      },
      outputSchema: {
        timestamp: z.string(),
        before: z.array(EntryJsonSchema),
        after: z.array(EntryJsonSchema),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      const timestamp = requireDateArg(args.timestamp, "timestamp");
      const levels = args.minLevel ? levelsAtOrAbove(args.minLevel) : undefined;
      const { before, after } = ctx.store.context({
        timestamp,
        before: args.before,
        after: args.after,
        source: args.source,
        levels,
      });

      if (before.length === 0 && after.length === 0) {
        return textResult(`No log entries found around ${timestamp.toISOString()}.`, {
          timestamp: timestamp.toISOString(),
          before: [],
          after: [],
        });
      }

      const lines = [`Context around ${timestamp.toISOString()}:`, ""];
      if (before.length > 0) {
        lines.push(`── BEFORE (${before.length}) ──`);
        for (const e of before) lines.push(...formatEntry(e));
        lines.push("");
      }
      lines.push(`━━ ${timestamp.toISOString()} ━━`, "");
      if (after.length > 0) {
        lines.push(`── AFTER (${after.length}) ──`);
        for (const e of after) lines.push(...formatEntry(e));
      }

      return textResult(lines.join("\n"), {
        timestamp: timestamp.toISOString(),
        before: before.map(entryToJson),
        after: after.map(entryToJson),
      });
    })
  );
}

const LEVEL_ORDER = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

function levelsAtOrAbove(min: (typeof LEVEL_ORDER)[number]): (typeof LEVEL_ORDER)[number][] {
  return LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(min));
}
