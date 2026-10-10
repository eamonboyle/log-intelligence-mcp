import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ADAPTER_TYPES } from "./types.js";

function userMessage(lines: string[]) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: lines.join("\n") },
      },
    ],
  };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "analyse-logs",
    {
      title: "Analyse logs",
      description: "Guided workflow to ingest logs, summarise errors, identify anomalies, and highlight patterns",
      argsSchema: {
        source: z.enum(ADAPTER_TYPES).describe("Log source type"),
        path: z.string().describe("Path to the log file or database"),
      },
    },
    ({ source, path }) =>
      userMessage([
        `Please analyse the logs from the ${source} source at "${path}". Follow these steps:`,
        "",
        `1. Ingest the logs using ingest_logs with source="${source}" and path="${path}"`,
        "2. Summarise the top errors using summarise_errors",
        "3. Check the error timeline with get_error_timeline (detectAnomalies=true)",
        "4. For the most frequent or anomalous errors, use get_log_context around their timestamps to see what preceded them",
        "5. If the logs carry structured properties, use group_by_property to see which component, host or user is most affected",
        "6. Provide a final assessment with:",
        "   - The most critical errors that need immediate attention",
        "   - Any concerning trends or spikes",
        "   - Recommendations for resolution",
      ])
  );

  server.registerPrompt(
    "investigate-error",
    {
      title: "Investigate an error",
      description: "Deep dive into a specific error pattern: search, timeline, context, and root cause analysis",
      argsSchema: {
        pattern: z.string().describe("Error message pattern, keyword or fingerprint to investigate"),
      },
    },
    ({ pattern }) =>
      userMessage([
        `Please investigate the error pattern: "${pattern}". Follow these steps:`,
        "",
        `1. Search for matching entries using search_logs with query="${pattern}" (or fingerprint if it is one)`,
        "2. Check get_error_timeline for the fingerprint to identify when it started and whether it is getting worse",
        "3. Use get_log_context around the first and most recent occurrence to see surrounding activity",
        "4. Look at summarise_errors to find related/similar error patterns occurring at the same time",
        "5. Based on the evidence, provide:",
        "   - Root cause hypothesis",
        "   - Impact assessment (frequency, affected sources, duration)",
        "   - Whether this is a new or recurring issue",
        "   - Suggested next steps for debugging",
      ])
  );

  server.registerPrompt(
    "review-deployment",
    {
      title: "Review a deployment",
      description: "Check whether a deployment introduced regressions by comparing errors before and after it",
      argsSchema: {
        deploymentDate: z.string().describe("Deployment date/time (ISO 8601)"),
        hoursAfter: z.string().optional().describe("Hours after the deployment to examine (default 24)"),
      },
    },
    ({ deploymentDate, hoursAfter }) =>
      userMessage([
        `Please review the deployment at ${deploymentDate}. Follow these steps:`,
        "",
        "1. Confirm logs are loaded with list_sources (ingest them if not)",
        `2. Run regression_after_date with deploymentDate="${deploymentDate}"${hoursAfter ? ` and hoursAfter=${hoursAfter}` : ""}`,
        "3. For each NEW error, use get_log_context around its first occurrence to understand the trigger",
        "4. For each INCREASED error, check get_error_timeline for the fingerprint to see whether the rate is still climbing",
        "5. Conclude with a go/no-go recommendation: should the deployment be rolled back, monitored, or considered healthy?",
      ])
  );
}
