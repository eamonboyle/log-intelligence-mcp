import { readFile } from "node:fs/promises";
import { ILogAdapter } from "./base.js";
import { LogEntry, LogLevel, SourceConfig } from "../types.js";

/**
 * Parses common flat-file log formats:
 *   - ISO timestamp + level + message (generic structured logs)
 *   - Apache/Nginx combined log format
 *   - Custom regex via config.pattern
 *
 * Also handles multi-line stack traces by appending continuation lines
 * to the previous entry's exception field.
 */

// Generic: 2024-01-15T10:30:00.000Z [ERROR] Something went wrong
const GENERIC_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+\[?(\w+)\]?\s+(.+)$/;

// Apache/Nginx combined: 127.0.0.1 - - [14/Feb/2026:10:30:00 +0000] "GET /api 500" 500 1234
const APACHE_RE =
  /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^"]+)"\s+(\d{3})\s+/;

export class FlatfileAdapter implements ILogAdapter {
  readonly type = "flatfile";

  async ingest(config: SourceConfig): Promise<LogEntry[]> {
    const raw = await readFile(config.path, "utf-8");
    const lines = raw.split(/\r?\n/);
    const entries: LogEntry[] = [];
    const customRe = config.pattern ? new RegExp(config.pattern) : null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      // Try custom pattern first
      if (customRe) {
        const m = customRe.exec(line);
        if (m) {
          entries.push(this.fromMatch(m, config));
          continue;
        }
      }

      // Try generic pattern
      const gm = GENERIC_RE.exec(line);
      if (gm) {
        entries.push({
          timestamp: new Date(gm[1]),
          level: this.mapLevel(gm[2]),
          message: gm[3],
          properties: {},
          source: config.name || config.path,
        });
        continue;
      }

      // Try Apache/Nginx pattern
      const am = APACHE_RE.exec(line);
      if (am) {
        const statusCode = parseInt(am[4], 10);
        entries.push({
          timestamp: this.parseApacheDate(am[2]),
          level: statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
          message: am[3],
          properties: { remoteAddr: am[1], statusCode },
          source: config.name || config.path,
        });
        continue;
      }

      // Continuation line (stack trace) — append to previous entry
      if (entries.length > 0 && (line.startsWith("   ") || line.startsWith("\t"))) {
        const prev = entries[entries.length - 1];
        prev.exception = prev.exception
          ? prev.exception + "\n" + line
          : line;
        continue;
      }

      // Unrecognised line — treat as info message with current time
      if (line.trim()) {
        entries.push({
          timestamp: new Date(),
          level: "info",
          message: line.trim(),
          properties: {},
          source: config.name || config.path,
        });
      }
    }

    return entries;
  }

  private fromMatch(m: RegExpExecArray, config: SourceConfig): LogEntry {
    // Expected named groups or positional: (timestamp) (level) (message)
    return {
      timestamp: new Date(m[1] || m.groups?.["timestamp"] || new Date().toISOString()),
      level: this.mapLevel(m[2] || m.groups?.["level"] || "info"),
      message: m[3] || m.groups?.["message"] || m[0],
      properties: {},
      source: config.name || config.path,
    };
  }

  private parseApacheDate(raw: string): Date {
    // Format: 14/Feb/2026:10:30:00 +0000
    const cleaned = raw.replace(":", " "); // first colon is date/time separator
    return new Date(cleaned);
  }

  private mapLevel(raw: string): LogLevel {
    const lower = raw.toLowerCase();
    const map: Record<string, LogLevel> = {
      trace: "trace",
      verbose: "trace",
      debug: "debug",
      info: "info",
      information: "info",
      warn: "warn",
      warning: "warn",
      error: "error",
      err: "error",
      fatal: "fatal",
      critical: "fatal",
      crit: "fatal",
      emerg: "fatal",
    };
    return map[lower] ?? "info";
  }
}
