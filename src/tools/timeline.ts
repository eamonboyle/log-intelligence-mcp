import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { detectAnomalies } from "../engine/anomaly.js";
import { AnomalyBucketJsonSchema, TimelineBucketJsonSchema, anomalyToJson, bucketToJson, formatTimeline, plural, shortIso } from "../format.js";
import { parseDateArg } from "../util/time.js";
import { ServerContext, guard, optionalIsoDate, sourceFilter, textResult } from "./common.js";

export function registerTimelineTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_error_timeline",
    {
      title: "Error timeline",
      description: "Error frequency bucketed over time as an ASCII chart, optionally with z-score spike detection.",
      inputSchema: {
        startDate: optionalIsoDate("Start of time range"),
        endDate: optionalIsoDate("End of time range"),
        fingerprint: z.string().optional().describe("Scope to a specific error fingerprint"),
        source: sourceFilter,
        bucketMinutes: z.number().positive().optional().describe(`Time bucket size in minutes (default ${ctx.config.defaults.bucketMinutes})`),
        detectAnomalies: z.boolean().optional().describe("Also run anomaly detection on the timeline (default false)"),
        anomalyThreshold: z.number().positive().optional().describe(`z-score threshold for anomalies (default ${ctx.config.defaults.anomalyThreshold})`),
      },
      outputSchema: {
        bucketMinutes: z.number(),
        totalErrors: z.number(),
        buckets: z.array(TimelineBucketJsonSchema),
        anomalies: z
          .object({
            threshold: z.number(),
            baselineMean: z.number(),
            baselineStddev: z.number(),
            buckets: z.array(AnomalyBucketJsonSchema),
          })
          .optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      const bucketMinutes = args.bucketMinutes ?? ctx.config.defaults.bucketMinutes;
      const startDate = parseDateArg(args.startDate, "startDate");
      const endDate = parseDateArg(args.endDate, "endDate");

      const errors = ctx.store.errors({ startDate, endDate, source: args.source, fingerprint: args.fingerprint });
      const buckets = ctx.store.timeline({
        startDate,
        endDate,
        fingerprint: args.fingerprint,
        source: args.source,
        bucketMinutes,
        levels: ["error", "fatal"],
      });

      if (buckets.length === 0) {
        return textResult("No error entries found for the specified criteria.", {
          bucketMinutes,
          totalErrors: 0,
          buckets: [],
        });
      }

      const lines = [
        `Error timeline (${plural(buckets.length, "bucket")}, ${bucketMinutes}min each, ${plural(errors.length, "error")}):`,
        "",
        ...formatTimeline(buckets),
      ];

      const structured: Record<string, unknown> = {
        bucketMinutes,
        totalErrors: errors.length,
        buckets: buckets.map(bucketToJson),
      };

      if (args.detectAnomalies) {
        const threshold = args.anomalyThreshold ?? ctx.config.defaults.anomalyThreshold;
        const result = detectAnomalies(errors, bucketMinutes, threshold);

        lines.push("");
        if (result.anomalousBuckets.length > 0) {
          lines.push(
            `Anomalies detected (threshold z>${threshold}):`,
            `Baseline: mean=${result.baselineMean}, stddev=${result.baselineStddev}`,
            ""
          );
          for (const ab of result.anomalousBuckets) {
            lines.push(`  ${shortIso(ab.start)} - ${ab.count} errors (z-score: ${ab.zScore.toFixed(2)})`);
          }
        } else {
          lines.push(`No anomalous spikes detected (threshold z>${threshold}, mean=${result.baselineMean}, stddev=${result.baselineStddev}).`);
        }

        structured.anomalies = {
          threshold,
          baselineMean: result.baselineMean,
          baselineStddev: result.baselineStddev,
          buckets: result.anomalousBuckets.map(anomalyToJson),
        };
      }

      return textResult(lines.join("\n"), structured);
    })
  );
}
