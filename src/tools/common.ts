import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LogStore } from "../engine/store.js";
import { AppConfig, LOG_LEVELS } from "../types.js";
import { ToolInputError } from "../util/time.js";

/** Everything a tool handler needs. Passed in rather than imported so tests can build isolated servers. */
export interface ServerContext {
  store: LogStore;
  config: AppConfig;
}

export function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wrap a tool handler so thrown errors become `isError` results instead of
 * protocol-level failures. Input problems are reported plainly; unexpected
 * errors are prefixed so the model can tell the two apart.
 */
export function guard<Args>(
  fn: (args: Args) => Promise<CallToolResult> | CallToolResult
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof ToolInputError) return errorResult(err);
      return errorResult(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

// ── Reusable argument schemas ────────────────────────────────────────────────

export const isoDate = (what: string) => z.string().describe(`${what} (ISO 8601, e.g. 2026-02-10T08:00:00Z)`);
export const optionalIsoDate = (what: string) => isoDate(what).optional();
export const levelSchema = z.enum(LOG_LEVELS);
export const sourceFilter = z.string().optional().describe("Only include entries whose source name contains this text");
