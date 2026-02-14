import { readFile } from "node:fs/promises";
import { ILogAdapter } from "./base.js";
import { LogEntry, LogLevel, LOG_LEVELS, SourceConfig } from "../types.js";

/**
 * Parses Serilog Compact Log Event Format (.clef) and standard Serilog JSON files.
 *
 * CLEF format fields:
 *   @t  – timestamp (ISO 8601)
 *   @l  – level (Verbose/Debug/Information/Warning/Error/Fatal)
 *   @mt – message template
 *   @m  – rendered message (optional, fallback to @mt)
 *   @x  – exception
 *   @i  – event id
 *   ...rest are properties
 */
export class SerilogAdapter implements ILogAdapter {
  readonly type = "serilog";

  async ingest(config: SourceConfig): Promise<LogEntry[]> {
    const raw = await readFile(config.path, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const entries: LogEntry[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const entry = this.parseLine(obj, config);
        if (entry) entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }

  private parseLine(
    obj: Record<string, unknown>,
    config: SourceConfig
  ): LogEntry | null {
    // Determine timestamp
    const rawTs = (obj["@t"] ?? obj["Timestamp"] ?? obj["timestamp"]) as string | undefined;
    if (!rawTs) return null;
    const timestamp = new Date(rawTs);
    if (isNaN(timestamp.getTime())) return null;

    // Determine level
    const rawLevel = (obj["@l"] ?? obj["Level"] ?? obj["level"] ?? "info") as string;
    const level = this.mapLevel(rawLevel);

    // Determine message
    const message = ((obj["@m"] ?? obj["@mt"] ?? obj["RenderedMessage"] ?? obj["message"] ?? "") as string);
    if (!message) return null;

    // Exception
    const exception = (obj["@x"] ?? obj["Exception"] ?? obj["exception"]) as string | undefined;

    // Collect remaining properties
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!["@t", "@l", "@m", "@mt", "@x", "@i", "@r", "Timestamp", "Level", "RenderedMessage", "Exception", "message", "timestamp", "level", "exception"].includes(key)) {
        properties[key] = value;
      }
    }

    return {
      timestamp,
      level,
      message,
      exception: exception || undefined,
      properties,
      source: config.name || config.path,
    };
  }

  private mapLevel(raw: string): LogLevel {
    const lower = raw.toLowerCase();
    const map: Record<string, LogLevel> = {
      verbose: "trace",
      trace: "trace",
      debug: "debug",
      information: "info",
      info: "info",
      warning: "warn",
      warn: "warn",
      error: "error",
      fatal: "fatal",
      critical: "fatal",
    };
    return map[lower] ?? "info";
  }
}
