import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { detectNewPatterns, summariseErrors } from "../engine/summarizer.js";
import { ClusterJsonSchema, clusterToJson, formatCluster, plural } from "../format.js";
import { parseDateArg, requireDateArg } from "../util/time.js";
import { ServerContext, guard, levelSchema, optionalIsoDate, isoDate, sourceFilter, textResult } from "./common.js";

export function registerErrorTools(server: McpServer, ctx: ServerContext): void {
  // ─── summarise_errors ───────────────────────────────────────────────────
  server.registerTool(
    "summarise_errors",
    {
      title: "Summarise errors",
      description:
        "Cluster error- and fatal-level entries by normalised message and list the top patterns with counts, time spans, sources and sample messages.",
      inputSchema: {
        startDate: optionalIsoDate("Start of time range"),
        endDate: optionalIsoDate("End of time range"),
        source: sourceFilter,
        minCount: z.number().int().positive().optional().describe("Minimum occurrences to include (default 1)"),
        topN: z.number().int().positive().optional().describe("Number of top clusters to return (default 10)"),
      },
      outputSchema: {
        totalErrors: z.number(),
        uniquePatterns: z.number(),
        clusters: z.array(ClusterJsonSchema),
        truncated: z.number().describe("Patterns beyond topN that were not returned"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      const entries = ctx.store.errors({
        startDate: parseDateArg(args.startDate, "startDate"),
        endDate: parseDateArg(args.endDate, "endDate"),
        source: args.source,
      });

      if (entries.length === 0) {
        return textResult("No error entries found matching the criteria.", {
          totalErrors: 0,
          uniquePatterns: 0,
          clusters: [],
          truncated: 0,
        });
      }

      const topN = args.topN ?? 10;
      const summary = summariseErrors(entries, topN, ctx.config.defaults.maxSamples, args.minCount ?? 1);

      const lines = [
        `Error Summary: ${plural(summary.uniquePatterns, "unique pattern")}, ${plural(summary.totalErrors, "error")} total`,
        "",
      ];
      summary.clusters.forEach((c, i) => lines.push(...formatCluster(c, i), ""));
      if (summary.truncated > 0) lines.push(`... and ${plural(summary.truncated, "more pattern")}`);

      return textResult(lines.join("\n"), {
        totalErrors: summary.totalErrors,
        uniquePatterns: summary.uniquePatterns,
        clusters: summary.clusters.map(clusterToJson),
        truncated: summary.truncated,
      });
    })
  );

  // ─── detect_new_error_pattern ───────────────────────────────────────────
  server.registerTool(
    "detect_new_error_pattern",
    {
      title: "Detect new error patterns",
      description:
        "Find error patterns present in a comparison window that never occurred in a baseline window. Useful for spotting novel failures after a change.",
      inputSchema: {
        baselineStart: isoDate("Start of baseline period"),
        baselineEnd: isoDate("End of baseline period"),
        comparisonStart: isoDate("Start of comparison period"),
        comparisonEnd: isoDate("End of comparison period"),
        source: sourceFilter,
      },
      outputSchema: {
        baselineErrors: z.number(),
        comparisonErrors: z.number(),
        newPatterns: z.array(ClusterJsonSchema),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      const baselineEntries = ctx.store.errors({
        startDate: requireDateArg(args.baselineStart, "baselineStart"),
        endDate: requireDateArg(args.baselineEnd, "baselineEnd"),
        source: args.source,
      });
      const comparisonEntries = ctx.store.errors({
        startDate: requireDateArg(args.comparisonStart, "comparisonStart"),
        endDate: requireDateArg(args.comparisonEnd, "comparisonEnd"),
        source: args.source,
      });

      const structured = (newPatterns: ReturnType<typeof detectNewPatterns>) => ({
        baselineErrors: baselineEntries.length,
        comparisonErrors: comparisonEntries.length,
        newPatterns: newPatterns.map(clusterToJson),
      });

      if (comparisonEntries.length === 0) {
        return textResult("No errors found in the comparison window.", structured([]));
      }

      const newPatterns = detectNewPatterns(baselineEntries, comparisonEntries, ctx.config.defaults.maxSamples);

      if (newPatterns.length === 0) {
        return textResult(
          `No new error patterns detected.\nBaseline errors: ${baselineEntries.length}\nComparison errors: ${comparisonEntries.length}`,
          structured([])
        );
      }

      const lines = [
        `Found ${plural(newPatterns.length, "NEW error pattern")} in comparison window:`,
        `(Baseline: ${baselineEntries.length} errors, Comparison: ${comparisonEntries.length} errors)`,
        "",
      ];
      newPatterns.forEach((c, i) => lines.push(...formatCluster(c, i), ""));

      return textResult(lines.join("\n"), structured(newPatterns));
    })
  );

  // ─── group_errors_by_property ───────────────────────────────────────────
  server.registerTool(
    "group_by_property",
    {
      title: "Group by property",
      description:
        "Count log entries by the value of a structured property (e.g. Application, StatusCode, user.id). " +
        "Use level, source or fingerprint as pseudo-properties. Defaults to error/fatal entries only.",
      inputSchema: {
        property: z.string().describe("Property name or dotted path, or one of: level, source, fingerprint"),
        startDate: optionalIsoDate("Start of time range"),
        endDate: optionalIsoDate("End of time range"),
        source: sourceFilter,
        level: levelSchema.optional().describe("Restrict to a single level"),
        errorsOnly: z.boolean().optional().describe("Only count error/fatal entries (default true, ignored when level is set)"),
        topN: z.number().int().positive().optional().describe("Number of groups to return (default 20)"),
      },
      outputSchema: {
        property: z.string(),
        total: z.number(),
        missing: z.number().describe("Entries without a value for the property"),
        groups: z.array(z.object({ value: z.string(), count: z.number() })),
        truncated: z.number(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      const errorsOnly = args.errorsOnly ?? true;
      const { groups, total, missing } = ctx.store.groupBy(args.property, {
        startDate: parseDateArg(args.startDate, "startDate"),
        endDate: parseDateArg(args.endDate, "endDate"),
        source: args.source,
        level: args.level,
        levels: !args.level && errorsOnly ? ["error", "fatal"] : undefined,
      });

      const topN = args.topN ?? 20;
      const top = groups.slice(0, topN);
      const truncated = Math.max(0, groups.length - top.length);

      if (total === 0) {
        return textResult("No entries matched the criteria.", { property: args.property, total, missing, groups: [], truncated: 0 });
      }
      if (top.length === 0) {
        return textResult(`None of the ${total} matching entries have a "${args.property}" property.`, {
          property: args.property,
          total,
          missing,
          groups: [],
          truncated: 0,
        });
      }

      const width = top.reduce((w, g) => Math.max(w, g.value.length), 5);
      const lines = [
        `Entries by "${args.property}" (${total} entries, ${missing} without the property):`,
        "",
      ];
      for (const g of top) {
        const pct = ((g.count / total) * 100).toFixed(1).padStart(5);
        lines.push(`  ${g.value.padEnd(width)}  ${String(g.count).padStart(6)}  ${pct}%`);
      }
      if (truncated > 0) lines.push("", `... and ${plural(truncated, "more value")}`);

      return textResult(lines.join("\n"), { property: args.property, total, missing, groups: top, truncated });
    })
  );
}
