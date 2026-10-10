import { LogEntry, LogLevel } from "./types.js";

/**
 * Single source of truth for mapping the many spellings of log levels that
 * appear in the wild onto the six canonical levels used internally.
 */
const LEVEL_ALIASES: Record<string, LogLevel> = {
  // trace
  trace: "trace",
  trc: "trace",
  verbose: "trace",
  vrb: "trace",
  // debug
  debug: "debug",
  dbg: "debug",
  // info
  info: "info",
  inf: "info",
  information: "info",
  informational: "info",
  notice: "info",
  // warn
  warn: "warn",
  wrn: "warn",
  warning: "warn",
  // error
  error: "error",
  err: "error",
  // fatal
  fatal: "fatal",
  ftl: "fatal",
  critical: "fatal",
  crit: "fatal",
  emerg: "fatal",
  emergency: "fatal",
  alert: "fatal",
  panic: "fatal",
};

/**
 * Numeric levels as used by pino / bunyan (10..60).
 *
 * Small integers (0..7) are deliberately NOT mapped: syslog counts 0 as most
 * severe while .NET LogLevel and App Insights count 0 as least severe, so
 * guessing would silently inflate or hide errors. They fall back to `info`.
 */
function numericLevel(n: number): LogLevel | undefined {
  if (n < 10) return undefined;
  if (n >= 60) return "fatal";
  if (n >= 50) return "error";
  if (n >= 40) return "warn";
  if (n >= 30) return "info";
  if (n >= 20) return "debug";
  return "trace";
}

/**
 * Normalise an arbitrary level value (string, number, null) to a LogLevel.
 */
export function normalizeLevel(raw: unknown, fallback: LogLevel = "info"): LogLevel {
  if (raw === null || raw === undefined) return fallback;

  if (typeof raw === "number") {
    return numericLevel(raw) ?? fallback;
  }

  const text = String(raw).trim().toLowerCase();
  if (!text) return fallback;

  const alias = LEVEL_ALIASES[text];
  if (alias) return alias;

  const asNumber = Number(text);
  if (!Number.isNaN(asNumber)) {
    return numericLevel(asNumber) ?? fallback;
  }

  return fallback;
}

export const ERROR_LEVELS: readonly LogLevel[] = ["error", "fatal"];

export function isErrorLevel(level: LogLevel): boolean {
  return level === "error" || level === "fatal";
}

export function isErrorEntry(entry: LogEntry): boolean {
  return isErrorLevel(entry.level);
}
