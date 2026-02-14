import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LogStore } from "./engine/store.js";
import { getAdapter } from "./adapters/index.js";
import { assignFingerprints, clusterErrors } from "./engine/clustering.js";
import { detectAnomalies } from "./engine/anomaly.js";
import { detectRegression } from "./engine/regression.js";
import { summariseErrors, detectNewPatterns } from "./engine/summarizer.js";
import { AdapterType, AppConfig, DEFAULT_CONFIG, LogEntry } from "./types.js";

// ── Shared State ────────────────────────────────────────────────────────────

export const store = new LogStore();
export let config: AppConfig = { ...DEFAULT_CONFIG };

export function setConfig(c: AppConfig): void {
  config = c;
}

// ── Server Creation ─────────────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "log-intelligence-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
        prompts: {},
      },
    }
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}

// ── Tool Registration ───────────────────────────────────────────────────────

function registerTools(server: McpServer): void {
  // ─── ingest_logs ────────────────────────────────────────────────────────
  server.tool(
    "ingest_logs",
    "Ingest log entries from a data source (Serilog JSON, Elasticsearch dump, SQLite database, or flat file)",
    {
      source: z.enum(["serilog", "elastic", "sql", "flatfile"]).describe("Log source adapter type"),
      path: z.string().describe("File path or connection string to the log source"),
      name: z.string().optional().describe("Friendly name for this source (defaults to path)"),
      table: z.string().optional().describe("Table name for SQL adapter"),
      filter: z.string().optional().describe("Filter expression (SQL WHERE clause or ES query)"),
      pattern: z.string().optional().describe("Custom regex pattern for flatfile adapter"),
      endpoint: z.string().optional().describe("Elasticsearch endpoint URL for live queries"),
      index: z.string().optional().describe("Elasticsearch index name"),
    },
    async (args) => {
      try {
        const adapter = getAdapter(args.source as AdapterType);
        const sourceConfig = {
          name: args.name || args.path,
          type: args.source as AdapterType,
          path: args.path,
          table: args.table,
          filter: args.filter,
          pattern: args.pattern,
          endpoint: args.endpoint,
          index: args.index,
        };

        const entries = await adapter.ingest(sourceConfig);
        assignFingerprints(entries);
        store.add(entries);

        const errors = entries.filter(
          (e) => e.level === "error" || e.level === "fatal"
        );

        return {
          content: [
            {
              type: "text",
              text: `Successfully ingested ${entries.length} log entries from "${sourceConfig.name}" (${args.source} adapter).\n` +
                `  - Errors/Fatal: ${errors.length}\n` +
                `  - Total entries in store: ${store.size}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to ingest logs: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── summarise_errors ───────────────────────────────────────────────────
  server.tool(
    "summarise_errors",
    "Summarise and cluster error-level log entries, showing top error patterns with counts, time spans, and sample messages",
    {
      startDate: z.string().optional().describe("Start of time range (ISO 8601)"),
      endDate: z.string().optional().describe("End of time range (ISO 8601)"),
      source: z.string().optional().describe("Filter by source name"),
      minCount: z.number().optional().describe("Minimum occurrences to include (default 1)"),
      topN: z.number().optional().describe("Number of top clusters to return (default 10)"),
    },
    async (args) => {
      const entries = store.errors({
        startDate: args.startDate ? new Date(args.startDate) : undefined,
        endDate: args.endDate ? new Date(args.endDate) : undefined,
        source: args.source,
      });

      if (entries.length === 0) {
        return {
          content: [
            { type: "text", text: "No error entries found matching the criteria." },
          ],
        };
      }

      const summary = summariseErrors(
        entries,
        args.topN ?? 10,
        config.defaults.maxSamples,
        args.minCount ?? 1
      );

      return {
        content: [{ type: "text", text: summary.text }],
      };
    }
  );

  // ─── detect_new_error_pattern ───────────────────────────────────────────
  server.tool(
    "detect_new_error_pattern",
    "Detect error patterns that are new in a comparison window vs. a baseline window. Useful for identifying novel failures after changes.",
    {
      baselineStart: z.string().describe("Start of baseline period (ISO 8601)"),
      baselineEnd: z.string().describe("End of baseline period (ISO 8601)"),
      comparisonStart: z.string().describe("Start of comparison period (ISO 8601)"),
      comparisonEnd: z.string().describe("End of comparison period (ISO 8601)"),
    },
    async (args) => {
      const baselineEntries = store.errors({
        startDate: new Date(args.baselineStart),
        endDate: new Date(args.baselineEnd),
      });

      const comparisonEntries = store.errors({
        startDate: new Date(args.comparisonStart),
        endDate: new Date(args.comparisonEnd),
      });

      if (comparisonEntries.length === 0) {
        return {
          content: [
            { type: "text", text: "No errors found in the comparison window." },
          ],
        };
      }

      const newPatterns = detectNewPatterns(
        baselineEntries,
        comparisonEntries,
        config.defaults.maxSamples
      );

      if (newPatterns.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No new error patterns detected.\nBaseline errors: ${baselineEntries.length}\nComparison errors: ${comparisonEntries.length}`,
            },
          ],
        };
      }

      const lines: string[] = [
        `Found ${newPatterns.length} NEW error pattern(s) in comparison window:`,
        `(Baseline: ${baselineEntries.length} errors, Comparison: ${comparisonEntries.length} errors)`,
        "",
      ];

      for (let i = 0; i < newPatterns.length; i++) {
        const c = newPatterns[i];
        lines.push(`#${i + 1} [${c.count}x] ${c.canonicalMessage}`);
        lines.push(`    Fingerprint: ${c.fingerprint}`);
        lines.push(`    First seen:  ${c.firstSeen.toISOString()}`);
        lines.push(`    Last seen:   ${c.lastSeen.toISOString()}`);
        lines.push(`    Sources:     ${c.sources.join(", ")}`);
        if (c.samples[0]?.exception) {
          lines.push(`    Exception:   ${c.samples[0].exception.split("\n")[0]}`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );

  // ─── regression_after_date ──────────────────────────────────────────────
  server.tool(
    "regression_after_date",
    "Detect error regressions after a deployment date. Compares error patterns before and after, identifying new errors, increased error rates, and resolved errors.",
    {
      deploymentDate: z.string().describe("Deployment date/time (ISO 8601)"),
      hoursBefore: z.number().optional().describe("Hours before deployment to use as baseline (default 168 = 1 week)"),
      hoursAfter: z.number().optional().describe("Hours after deployment to analyse (default 24)"),
    },
    async (args) => {
      const allEntries = store.all();
      if (allEntries.length === 0) {
        return {
          content: [
            { type: "text", text: "No log entries in store. Ingest logs first using ingest_logs." },
          ],
        };
      }

      const report = detectRegression(
        allEntries,
        new Date(args.deploymentDate),
        args.hoursBefore ?? 168,
        args.hoursAfter ?? 24,
        config.defaults.maxSamples
      );

      const lines: string[] = [
        `Regression Report for deployment at ${report.deploymentDate.toISOString()}`,
        `Before window: ${report.beforeWindow.start.toISOString()} → ${report.beforeWindow.end.toISOString()}`,
        `After window:  ${report.afterWindow.start.toISOString()} → ${report.afterWindow.end.toISOString()}`,
        "",
        report.summary,
        "",
      ];

      if (report.newErrors.length > 0) {
        lines.push("── NEW ERRORS ──────────────────────────────────────");
        for (const c of report.newErrors) {
          lines.push(`  [${c.count}x] ${c.canonicalMessage}`);
          lines.push(`    Fingerprint: ${c.fingerprint}`);
          if (c.samples[0]?.exception) {
            lines.push(`    Exception:   ${c.samples[0].exception.split("\n")[0]}`);
          }
        }
        lines.push("");
      }

      if (report.increasedErrors.length > 0) {
        lines.push("── INCREASED ERRORS ────────────────────────────────");
        for (const ie of report.increasedErrors) {
          lines.push(`  [${ie.cluster.count}x] ${ie.cluster.canonicalMessage}`);
          lines.push(`    Before: ${ie.beforeRate}/hr → After: ${ie.afterRate}/hr (${ie.increaseRatio}x increase)`);
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

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );

  // ─── search_logs ────────────────────────────────────────────────────────
  server.tool(
    "search_logs",
    "Full-text search across all ingested log entries. Searches message and exception text.",
    {
      query: z.string().describe("Search term (substring match, case-insensitive)"),
      level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional().describe("Filter by log level"),
      startDate: z.string().optional().describe("Start of time range (ISO 8601)"),
      endDate: z.string().optional().describe("End of time range (ISO 8601)"),
      limit: z.number().optional().describe("Max results to return (default 50)"),
    },
    async (args) => {
      const results = store.query({
        search: args.query,
        level: args.level as any,
        startDate: args.startDate ? new Date(args.startDate) : undefined,
        endDate: args.endDate ? new Date(args.endDate) : undefined,
        limit: args.limit ?? 50,
      });

      if (results.length === 0) {
        return {
          content: [
            { type: "text", text: `No log entries found matching "${args.query}".` },
          ],
        };
      }

      const lines: string[] = [
        `Found ${results.length} entries matching "${args.query}":`,
        "",
      ];

      for (const entry of results) {
        lines.push(
          `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}] ${entry.message}`
        );
        if (entry.exception) {
          lines.push(`  Exception: ${entry.exception.split("\n")[0]}`);
        }
        lines.push(`  Source: ${entry.source} | Fingerprint: ${entry.fingerprint ?? "N/A"}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );

  // ─── get_error_timeline ─────────────────────────────────────────────────
  server.tool(
    "get_error_timeline",
    "Get error frequency bucketed over time. Useful for visualising error rate trends and spotting spikes.",
    {
      startDate: z.string().optional().describe("Start of time range (ISO 8601)"),
      endDate: z.string().optional().describe("End of time range (ISO 8601)"),
      fingerprint: z.string().optional().describe("Scope to a specific error fingerprint"),
      bucketMinutes: z.number().optional().describe("Time bucket size in minutes (default 60)"),
      detectAnomalies: z.boolean().optional().describe("Also run anomaly detection on the timeline (default false)"),
    },
    async (args) => {
      const buckets = store.timeline({
        startDate: args.startDate ? new Date(args.startDate) : undefined,
        endDate: args.endDate ? new Date(args.endDate) : undefined,
        fingerprint: args.fingerprint,
        bucketMinutes: args.bucketMinutes ?? config.defaults.bucketMinutes,
        levels: ["error", "fatal"],
      });

      if (buckets.length === 0) {
        return {
          content: [
            { type: "text", text: "No error entries found for the specified criteria." },
          ],
        };
      }

      const lines: string[] = [
        `Error timeline (${buckets.length} buckets, ${args.bucketMinutes ?? config.defaults.bucketMinutes}min each):`,
        "",
        "Time                          | Count | Bar",
        "─────────────────────────────┼───────┼────────────────────",
      ];

      const maxCount = Math.max(...buckets.map((b) => b.count));

      for (const bucket of buckets) {
        const barLen = maxCount > 0 ? Math.round((bucket.count / maxCount) * 20) : 0;
        const bar = "█".repeat(barLen);
        lines.push(
          `${bucket.start.toISOString().slice(0, 19)} | ${String(bucket.count).padStart(5)} | ${bar}`
        );
      }

      // Optional anomaly detection
      if (args.detectAnomalies) {
        const errors = store.errors({
          startDate: args.startDate ? new Date(args.startDate) : undefined,
          endDate: args.endDate ? new Date(args.endDate) : undefined,
        });

        const anomalyResult = detectAnomalies(
          errors,
          args.bucketMinutes ?? config.defaults.bucketMinutes,
          config.defaults.anomalyThreshold,
          args.fingerprint
        );

        if (anomalyResult.anomalousBuckets.length > 0) {
          lines.push("");
          lines.push(`Anomalies detected (threshold z>${config.defaults.anomalyThreshold}):`);
          lines.push(`Baseline: mean=${anomalyResult.baselineMean}, stddev=${anomalyResult.baselineStddev}`);
          lines.push("");
          for (const ab of anomalyResult.anomalousBuckets) {
            lines.push(
              `  ${ab.start.toISOString().slice(0, 19)} - ${ab.count} errors (z-score: ${ab.zScore.toFixed(2)})`
            );
          }
        } else {
          lines.push("");
          lines.push("No anomalous spikes detected.");
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );
}

// ── Resource Registration ───────────────────────────────────────────────────

function registerResources(server: McpServer): void {
  // logs://sources
  server.resource(
    "log-sources",
    "logs://sources",
    { description: "List all configured and ingested log sources with entry counts" },
    async (uri) => {
      const sources = store.getSourceInfo();

      if (sources.length === 0) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ sources: [], message: "No logs ingested yet. Use ingest_logs to load data." }, null, 2),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                sources: sources.map((s) => ({
                  name: s.name,
                  entryCount: s.entryCount,
                  errorCount: s.errorCount,
                  timeRange: s.timeRange
                    ? {
                        earliest: s.timeRange.earliest.toISOString(),
                        latest: s.timeRange.latest.toISOString(),
                      }
                    : null,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // logs://summary
  server.resource(
    "log-summary",
    "logs://summary",
    { description: "Current log store stats: total entries, error count, unique clusters, time range" },
    async (uri) => {
      const summary = store.getSummary();
      const allEntries = store.all();
      assignFingerprints(allEntries);
      const clusters = clusterErrors(allEntries, 1);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                totalEntries: summary.totalEntries,
                errorCount: summary.errorCount,
                uniqueSources: summary.uniqueSources,
                uniqueErrorPatterns: clusters.length,
                timeRange: summary.timeRange
                  ? {
                      earliest: summary.timeRange.earliest.toISOString(),
                      latest: summary.timeRange.latest.toISOString(),
                    }
                  : null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

// ── Prompt Registration ─────────────────────────────────────────────────────

function registerPrompts(server: McpServer): void {
  // analyse-logs
  server.prompt(
    "analyse-logs",
    "Guided workflow to ingest logs, summarise errors, identify anomalies, and highlight patterns",
    {
      source: z.string().describe("Log source type: serilog, elastic, sql, or flatfile"),
      path: z.string().describe("Path to the log file or database"),
    },
    ({ source, path }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Please analyse the logs from the ${source} source at "${path}". Follow these steps:`,
              "",
              `1. First, ingest the logs using the ingest_logs tool with source="${source}" and path="${path}"`,
              "2. Then summarise the top errors using summarise_errors",
              "3. Check the error timeline with get_error_timeline (enable anomaly detection)",
              "4. If there are anomalies, investigate the top error patterns",
              "5. Provide a final assessment with:",
              "   - The most critical errors that need immediate attention",
              "   - Any concerning trends or spikes",
              "   - Recommendations for resolution",
            ].join("\n"),
          },
        },
      ],
    })
  );

  // investigate-error
  server.prompt(
    "investigate-error",
    "Deep dive into a specific error pattern: search, timeline, clustering, and root cause analysis",
    {
      pattern: z.string().describe("Error message pattern or keyword to investigate"),
    },
    ({ pattern }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Please investigate the error pattern: "${pattern}". Follow these steps:`,
              "",
              `1. Search for matching log entries using search_logs with query="${pattern}"`,
              "2. Check the error timeline for this pattern to identify when it started and if it's getting worse",
              "3. Look at the error summary to find related/similar error patterns",
              "4. Based on the evidence, provide:",
              "   - Root cause hypothesis",
              "   - Impact assessment (frequency, affected sources, duration)",
              "   - Whether this is a new or recurring issue",
              "   - Suggested next steps for debugging",
            ].join("\n"),
          },
        },
      ],
    })
  );
}
