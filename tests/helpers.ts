import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { LogEntry, LogLevel } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function samplePath(name: string): string {
  return resolve(here, "..", "samples", name);
}

export function entry(
  timestamp: string,
  level: LogLevel,
  message: string,
  extra: Partial<Omit<LogEntry, "timestamp" | "level" | "message">> = {}
): LogEntry {
  return {
    timestamp: new Date(timestamp),
    level,
    message,
    properties: {},
    source: "test",
    ...extra,
  };
}

/** n entries, `minutesApart` apart, starting at `start`. */
export function series(start: string, n: number, minutesApart: number, level: LogLevel, message: string): LogEntry[] {
  const t0 = new Date(start).getTime();
  return Array.from({ length: n }, (_, i) => entry(new Date(t0 + i * minutesApart * 60_000).toISOString(), level, message));
}
