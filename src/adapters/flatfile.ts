import { ILogAdapter, requirePath } from "./base.js";
import { readLines } from "./lines.js";
import { normalizeLevel } from "../levels.js";
import { IngestResult, LogEntry, SourceConfig } from "../types.js";

/**
 * Parses common flat-file log formats:
 *   - ISO timestamp + level + message (generic structured logs)
 *   - Apache/Nginx combined log format
 *   - Custom regex via config.pattern (positional groups 1-3 or named groups
 *     `timestamp`, `level`, `message`)
 *
 * Lines that do not start a new entry (stack frames, "Caused by:", wrapped
 * text) are attached to the previous entry as its exception/continuation
 * text, so multi-line stack traces stay with the message that produced them.
 * Leading lines that cannot be attributed to any entry are counted as skipped
 * rather than being given a fake "now" timestamp.
 */

// Generic: 2024-01-15T10:30:00.000Z [ERROR] Something went wrong
//          2024-01-15 10:30:00,123 ERROR Something went wrong
const GENERIC_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+\[?(\w+)\]?\s*[:-]?\s+(.+)$/;

// Apache/Nginx combined: 127.0.0.1 - - [14/Feb/2026:10:30:00 +0000] "GET /api HTTP/1.1" 500 1234
const APACHE_RE = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+(\S+)/;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Parse an Apache CLF timestamp: `14/Feb/2026:10:30:00 +0000`.
 */
export function parseApacheDate(raw: string): Date {
  const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-]\d{4}))?$/.exec(raw.trim());
  if (!m) return new Date(NaN);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return new Date(NaN);
  const tz = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : "Z";
  return new Date(`${m[3]}-${month}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}${tz}`);
}

/** Normalise `2024-01-15 10:30:00,123` style timestamps so Date can parse them. */
function parseLooseTimestamp(raw: string): Date {
  return new Date(raw.replace(" ", "T").replace(",", "."));
}

export class FlatfileAdapter implements ILogAdapter {
  readonly type = "flatfile";

  async ingest(config: SourceConfig): Promise<IngestResult> {
    const path = requirePath(config, "flatfile");
    const source = config.name || path;
    const entries: LogEntry[] = [];
    let skipped = 0;

    let customRe: RegExp | null = null;
    if (config.pattern) {
      try {
        customRe = new RegExp(config.pattern);
      } catch (err) {
        throw new Error(`Invalid flatfile pattern: ${(err as Error).message}`);
      }
    }

    for await (const line of readLines(path)) {
      if (!line.trim()) continue;

      const entry = this.parseLine(line, customRe, source);
      if (entry) {
        entries.push(entry);
        continue;
      }

      // Continuation of the previous entry (stack frame, "Caused by:", wrapped text)
      const prev = entries[entries.length - 1];
      if (prev) {
        prev.exception = prev.exception ? `${prev.exception}\n${line}` : line.trimEnd();
      } else {
        skipped++;
      }
    }

    const warnings: string[] = [];
    if (skipped > 0) warnings.push(`${skipped} leading line(s) had no recognisable timestamp and were skipped`);
    return { entries, skipped, warnings };
  }

  private parseLine(line: string, customRe: RegExp | null, source: string): LogEntry | null {
    if (customRe) {
      const m = customRe.exec(line);
      if (m) {
        const entry = this.fromMatch(m, source);
        if (entry) return entry;
      }
    }

    const gm = GENERIC_RE.exec(line);
    if (gm) {
      const timestamp = parseLooseTimestamp(gm[1]);
      if (!Number.isNaN(timestamp.getTime())) {
        return {
          timestamp,
          level: normalizeLevel(gm[2]),
          message: gm[3].trim(),
          properties: {},
          source,
        };
      }
    }

    const am = APACHE_RE.exec(line);
    if (am) {
      const timestamp = parseApacheDate(am[2]);
      if (!Number.isNaN(timestamp.getTime())) {
        const statusCode = parseInt(am[4], 10);
        const [method, requestPath, protocol] = am[3].split(" ");
        return {
          timestamp,
          level: statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
          message: am[3],
          properties: {
            remoteAddr: am[1],
            statusCode,
            method,
            path: requestPath,
            protocol,
            bytes: am[5] === "-" ? 0 : parseInt(am[5], 10),
          },
          source,
        };
      }
    }

    return null;
  }

  private fromMatch(m: RegExpExecArray, source: string): LogEntry | null {
    const groups = m.groups ?? {};
    const rawTs = groups["timestamp"] ?? m[1];
    const rawLevel = groups["level"] ?? m[2] ?? "info";
    const message = groups["message"] ?? m[3] ?? m[0];
    if (!rawTs) return null;

    const timestamp = parseLooseTimestamp(rawTs);
    if (Number.isNaN(timestamp.getTime())) return null;

    return {
      timestamp,
      level: normalizeLevel(rawLevel),
      message: message.trim(),
      properties: {},
      source,
    };
  }
}
