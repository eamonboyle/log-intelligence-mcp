import { LogEntry, LogLevel, SourceInfo, TimelineBucket } from "../types.js";

/**
 * In-memory log store with time-range queries, level filtering,
 * full-text search, and source tracking.
 */
export class LogStore {
  private entries: LogEntry[] = [];
  private sourceNames: Set<string> = new Set();

  /** Total number of stored entries */
  get size(): number {
    return this.entries.length;
  }

  /** Add entries to the store */
  add(entries: LogEntry[]): void {
    for (const entry of entries) {
      this.entries.push(entry);
      this.sourceNames.add(entry.source);
    }
    // Keep sorted by timestamp for efficient range queries
    this.entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /** Clear all entries */
  clear(): void {
    this.entries = [];
    this.sourceNames.clear();
  }

  /** Get all entries */
  all(): LogEntry[] {
    return this.entries;
  }

  /** Query entries with optional filters */
  query(opts: {
    startDate?: Date;
    endDate?: Date;
    level?: LogLevel;
    levels?: LogLevel[];
    source?: string;
    search?: string;
    limit?: number;
  }): LogEntry[] {
    let result = this.entries;

    if (opts.startDate) {
      const start = opts.startDate.getTime();
      result = result.filter((e) => e.timestamp.getTime() >= start);
    }

    if (opts.endDate) {
      const end = opts.endDate.getTime();
      result = result.filter((e) => e.timestamp.getTime() <= end);
    }

    if (opts.level) {
      result = result.filter((e) => e.level === opts.level);
    }

    if (opts.levels && opts.levels.length > 0) {
      const set = new Set(opts.levels);
      result = result.filter((e) => set.has(e.level));
    }

    if (opts.source) {
      const src = opts.source.toLowerCase();
      result = result.filter((e) => e.source.toLowerCase().includes(src));
    }

    if (opts.search) {
      const term = opts.search.toLowerCase();
      result = result.filter(
        (e) =>
          e.message.toLowerCase().includes(term) ||
          (e.exception && e.exception.toLowerCase().includes(term))
      );
    }

    if (opts.limit && opts.limit > 0) {
      result = result.slice(0, opts.limit);
    }

    return result;
  }

  /** Get only error-level entries (error + fatal) */
  errors(opts?: { startDate?: Date; endDate?: Date; source?: string }): LogEntry[] {
    return this.query({
      ...opts,
      levels: ["error", "fatal"],
    });
  }

  /** Bucket entries into time windows for timeline display */
  timeline(opts: {
    startDate?: Date;
    endDate?: Date;
    bucketMinutes?: number;
    fingerprint?: string;
    levels?: LogLevel[];
  }): TimelineBucket[] {
    let entries = this.query({
      startDate: opts.startDate,
      endDate: opts.endDate,
      levels: opts.levels,
    });

    if (opts.fingerprint) {
      entries = entries.filter((e) => e.fingerprint === opts.fingerprint);
    }

    if (entries.length === 0) return [];

    const bucketMs = (opts.bucketMinutes ?? 60) * 60 * 1000;
    const minTime = entries[0].timestamp.getTime();
    const maxTime = entries[entries.length - 1].timestamp.getTime();

    const buckets: TimelineBucket[] = [];
    let current = Math.floor(minTime / bucketMs) * bucketMs;

    while (current <= maxTime) {
      const bucketStart = current;
      const bucketEnd = current + bucketMs;
      const count = entries.filter(
        (e) =>
          e.timestamp.getTime() >= bucketStart &&
          e.timestamp.getTime() < bucketEnd
      ).length;

      buckets.push({
        start: new Date(bucketStart),
        end: new Date(bucketEnd),
        count,
      });

      current += bucketMs;
    }

    return buckets;
  }

  /** Get info about all ingested sources */
  getSourceInfo(): SourceInfo[] {
    const infos: SourceInfo[] = [];

    for (const sourceName of this.sourceNames) {
      const sourceEntries = this.entries.filter((e) => e.source === sourceName);
      const errorEntries = sourceEntries.filter(
        (e) => e.level === "error" || e.level === "fatal"
      );

      let timeRange: { earliest: Date; latest: Date } | null = null;
      if (sourceEntries.length > 0) {
        timeRange = {
          earliest: sourceEntries[0].timestamp,
          latest: sourceEntries[sourceEntries.length - 1].timestamp,
        };
      }

      infos.push({
        name: sourceName,
        type: "serilog", // default; real type is tracked at ingestion
        entryCount: sourceEntries.length,
        errorCount: errorEntries.length,
        timeRange,
      });
    }

    return infos;
  }

  /** Get overall summary stats */
  getSummary(): {
    totalEntries: number;
    errorCount: number;
    uniqueSources: number;
    timeRange: { earliest: Date; latest: Date } | null;
  } {
    const errors = this.entries.filter(
      (e) => e.level === "error" || e.level === "fatal"
    );

    let timeRange: { earliest: Date; latest: Date } | null = null;
    if (this.entries.length > 0) {
      timeRange = {
        earliest: this.entries[0].timestamp,
        latest: this.entries[this.entries.length - 1].timestamp,
      };
    }

    return {
      totalEntries: this.entries.length,
      errorCount: errors.length,
      uniqueSources: this.sourceNames.size,
      timeRange,
    };
  }
}
