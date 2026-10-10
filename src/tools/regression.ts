import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { detectRegression } from "../engine/regression.js";
import { ClusterJsonSchema, clusterToJson, firstLine, iso } from "../format.js";
import { requireDateArg } from "../util/time.js";
import { ServerContext, guard, isoDate, sourceFilter, textResult } from "./common.js";

export function registerRegressionTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "regression_after_date",
    {
      title: "Regression after deployment",
      description:
        "Compare error patterns before and after a deployment date. Reports new errors, errors whose hourly rate increased, and errors that disappeared.",
      inputSchema: {
        deploymentDate: isoDate("Deployment date/time"),
        hoursBefore: z.number().positive().optional().describe("Hours before deployment to use as baseline (default 168 = 1 week)"),
        hoursAfter: z.number().positive().optional().describe("Hours after deployment to analyse (default 24)"),
        increaseFactor: z.number().positive().optional().describe("Flag an existing error as increased when its rate grows by more than this factor (default 2)"),
        source: sourceFilter,
      },
      outputSchema: {
        deploymentDate: z.string(),
        beforeWindow: z.object({ start: z.string(), end: z.string() }),
        afterWindow: z.object({ start: z.string(), end: z.string() }),
        summary: z.string(),
        newErrors: z.array(ClusterJsonSchema),
        increasedErrors: z.array(
          z.object({
            cluster: ClusterJsonSchema,
            beforeRatePerHour: z.number(),
            afterRatePerHour: z.number(),
            increaseRatio: z.number().nullable(),
          })
        ),
        resolvedErrors: z.array(ClusterJsonSchema),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async (args) => {
      const entries = args.source ? ctx.store.query({ source: args.source }) : ctx.store.all();
      if (entries.length === 0) {
        throw new Error("No log entries in store. Ingest logs first using ingest_logs.");
      }

      const report = detectRegression(entries, requireDateArg(args.deploymentDate, "deploymentDate"), {
        hoursBefore: args.hoursBefore,
        hoursAfter: args.hoursAfter,
        increaseFactor: args.increaseFactor,
        maxSamples: ctx.config.defaults.maxSamples,
      });

      const lines = [
        `Regression Report for deployment at ${iso(report.deploymentDate)}`,
        `Before window: ${iso(report.beforeWindow.start)} → ${iso(report.beforeWindow.end)}`,
        `After window:  ${iso(report.afterWindow.start)} → ${iso(report.afterWindow.end)}`,
        "",
        report.summary,
        "",
      ];

      if (report.newErrors.length > 0) {
        lines.push("── NEW ERRORS ──────────────────────────────────────");
        for (const c of report.newErrors) {
          lines.push(`  [${c.count}x] ${c.canonicalMessage}`, `    Fingerprint: ${c.fingerprint}`);
          const ex = firstLine(c.samples[0]?.exception);
          if (ex) lines.push(`    Exception:   ${ex}`);
        }
        lines.push("");
      }

      if (report.increasedErrors.length > 0) {
        lines.push("── INCREASED ERRORS ────────────────────────────────");
        for (const ie of report.increasedErrors) {
          const ratio = ie.increaseRatio === null ? "new baseline" : `${ie.increaseRatio}x increase`;
          lines.push(
            `  [${ie.cluster.count}x] ${ie.cluster.canonicalMessage}`,
            `    Before: ${ie.beforeRate}/hr → After: ${ie.afterRate}/hr (${ratio})`
          );
        }
        lines.push("");
      }

      if (report.resolvedErrors.length > 0) {
        lines.push("── RESOLVED ERRORS ─────────────────────────────────");
        for (const c of report.resolvedErrors) {
          lines.push(`  [was ${c.count}x] ${c.canonicalMessage}`);
        }
        lines.push("");
      }

      return textResult(lines.join("\n"), {
        deploymentDate: iso(report.deploymentDate),
        beforeWindow: { start: iso(report.beforeWindow.start), end: iso(report.beforeWindow.end) },
        afterWindow: { start: iso(report.afterWindow.start), end: iso(report.afterWindow.end) },
        summary: report.summary,
        newErrors: report.newErrors.map(clusterToJson),
        increasedErrors: report.increasedErrors.map((ie) => ({
          cluster: clusterToJson(ie.cluster),
          beforeRatePerHour: ie.beforeRate,
          afterRatePerHour: ie.afterRate,
          increaseRatio: ie.increaseRatio,
        })),
        resolvedErrors: report.resolvedErrors.map(clusterToJson),
      });
    })
  );
}
