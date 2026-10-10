import { isErrorEntry } from "../levels.js";
import { getPath, asString } from "../util/object.js";
import { bucketize } from "../util/time.js";
import { AdapterType, GroupCount, LogEntry, LogLevel, SourceConfig, SourceInfo, TimelineBucket } from "../types.js";

export interface QueryOptions {
  startDate?: Date;
  endDate?: Date;
  level?: LogLevel;
  levels?: readonly LogLevel[];
  source?: string;
  fingerprint?: string;
  /** Case-insensitive substring match on message and exception */
  search?: string;
  /** Treat `search` as a regular expression */
  regex?: boolean;
  limit?: number;
}

interface SourceMeta {
  name: string;
  type: AdapterType;
  config: SourceConfig;
  ingestedAt: Date;
}

/**
 * In-memory log store with time-range queries, level filtering,
 * full-text search, and source tracking. Entries are kept sorted by
 * timestamp so range queries and context lookups can use binary search.
 */
export class LogStore {
  private entries: LogEntry[] = [];
  private sources = new Map<string, SourceMeta>();

  /** Total number of stored entries */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Add entries from a source. Entries are merged into timestamp order.
   */
  add(entries: readonly LogEntry[], source: { name: string; type: AdapterType; config: SourceConfig }): void {
    if (entries.length > 0) {
      const incoming = [...entries].sort(byTimestamp);
      this.entries = this.entries.length === 0 ? incoming : merge(this.entries, incoming);
    }
    this.sources.set(source.name, { ...source, ingestedAt: new Date() });
  }

  /** Whether a source with this name has been ingested. */
  hasSource(name: string): boolean {
    return this.sources.has(name);
  }

  /** Remove all entries belonging to a source. Returns the number removed. */
  removeSource(name: string): number {
    if (!this.sources.has(name)) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.source !== name);
    this.sources.delete(name);
    return before - this.entries.length;
  }

  /** Clear all entries and sources. */
  clear(): void {
    this.entries = [];
    this.sources.clear();
  }

  /** Get all entries (sorted by timestamp). */
  all(): readonly LogEntry[] {
    return this.entries;
  }

  /** Query entries with optional filters. */
  query(opts: QueryOptions = {}): LogEntry[] {
    let result: LogEntry[] = this.slice(opts.startDate, opts.endDate);

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

    if (opts.fingerprint) {
      result = result.filter((e) => e.fingerprint === opts.fingerprint);
    }

    if (opts.search) {
      const matcher = buildMatcher(opts.search, opts.regex ?? false);
      result = result.filter((e) => matcher(e.message) || (e.exception !== undefined && matcher(e.exception)));
    }

    if (opts.limit && opts.limit > 0 && result.length > opts.limit) {
      result = result.slice(0, opts.limit);
    }

    return result;
  }

  /** Get only error-level entries (error + fatal). */
  errors(opts: Omit<QueryOptions, "level" | "levels"> = {}): LogEntry[] {
    return this.query({ ...opts, levels: ["error", "fatal"] });
  }

  /**
   * Entries surrounding a point in time: `before` entries at or before the
   * timestamp and `after` entries strictly after it.
   */
  context(opts: {
    timestamp: Date;
    before?: number;
    after?: number;
    source?: string;
    levels?: readonly LogLevel[];
  }): { before: LogEntry[]; after: LogEntry[] } {
    const beforeN = opts.before ?? 10;
    const afterN = opts.after ?? 10;

    let pool: LogEntry[] = this.entries;
    if (opts.source || (opts.levels && opts.levels.length > 0)) {
      pool = this.query({ source: opts.source, levels: opts.levels });
    }

    const t = opts.timestamp.getTime();
    // first index with timestamp > t
    const split = upperBound(pool, t);
    return {
      before: pool.slice(Math.max(0, split - beforeN), split),
      after: pool.slice(split, split + afterN),
    };
  }

  /** Bucket entries into time windows for timeline display. */
  timeline(opts: {
    startDate?: Date;
    endDate?: Date;
    bucketMinutes?: number;
    fingerprint?: string;
    source?: string;
    levels?: readonly LogLevel[];
  }): TimelineBucket[] {
    const entries = this.query({
      startDate: opts.startDate,
      endDate: opts.endDate,
      levels: opts.levels,
      fingerprint: opts.fingerprint,
      source: opts.source,
    });

    const bucketMs = (opts.bucketMinutes ?? 60) * 60 * 1000;
    return bucketize(entries, bucketMs).map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
      count: b.count,
    }));
  }

  /**
   * Count entries by the value of a property. `level`, `source` and
   * `fingerprint` are available as pseudo-properties; anything else is looked
   * up in `entry.properties` (dotted paths supported).
   */
  groupBy(property: string, opts: QueryOptions = {}): { groups: GroupCount[]; total: number; missing: number } {
    const entries = this.query(opts);
    const counts = new Map<string, number>();
    let missing = 0;

    for (const e of entries) {
      let value: unknown;
      switch (property) {
        case "level":
          value = e.level;
          break;
        case "source":
          value = e.source;
          break;
        case "fingerprint":
          value = e.fingerprint;
          break;
        default:
          value = getPath(e.properties, property);
      }
      if (value === undefined || value === null || value === "") {
        missing++;
        continue;
      }
      const key = asString(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const groups = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

    return { groups, total: entries.length, missing };
  }

  /** Get info about all ingested sources. */
  getSourceInfo(): SourceInfo[] {
    const stats = new Map<string, { count: number; errors: number; earliest?: Date; latest?: Date }>();
    for (const e of this.entries) {
      let s = stats.get(e.source);
      if (!s) {
        s = { count: 0, errors: 0 };
        stats.set(e.source, s);
      }
      s.count++;
      if (isErrorEntry(e)) s.errors++;
      // entries are sorted, so the first seen is earliest and the last seen is latest
      if (!s.earliest) s.earliest = e.timestamp;
      s.latest = e.timestamp;
    }

    return [...this.sources.values()].map((meta) => {
      const s = stats.get(meta.name);
      return {
        name: meta.name,
        type: meta.type,
        entryCount: s?.count ?? 0,
        errorCount: s?.errors ?? 0,
        timeRange: s?.earliest && s.latest ? { earliest: s.earliest, latest: s.latest } : null,
        ingestedAt: meta.ingestedAt,
      };
    });
  }

  /** Get overall summary stats. */
  getSummary(): {
    totalEntries: number;
    errorCount: number;
    uniqueSources: number;
    timeRange: { earliest: Date; latest: Date } | null;
  } {
    let errorCount = 0;
    for (const e of this.entries) if (isErrorEntry(e)) errorCount++;

    return {
      totalEntries: this.entries.length,
      errorCount,
      uniqueSources: this.sources.size,
      timeRange:
        this.entries.length > 0
          ? { earliest: this.entries[0].timestamp, latest: this.entries[this.entries.length - 1].timestamp }
          : null,
    };
  }

  /** Entries within [start, end] using binary search on the sorted array. */
  private slice(start?: Date, end?: Date): LogEntry[] {
    if (!start && !end) return this.entries;
    const from = start ? lowerBound(this.entries, start.getTime()) : 0;
    const to = end ? upperBound(this.entries, end.getTime()) : this.entries.length;
    return from < to ? this.entries.slice(from, to) : [];
  }
}

function byTimestamp(a: LogEntry, b: LogEntry): number {
  return a.timestamp.getTime() - b.timestamp.getTime();
}

/** Merge two timestamp-sorted arrays. */
function merge(a: LogEntry[], b: LogEntry[]): LogEntry[] {
  const out = new Array<LogEntry>(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    out[k++] = byTimestamp(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  }
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** First index whose timestamp >= t */
function lowerBound(entries: readonly LogEntry[], t: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].timestamp.getTime() < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose timestamp > t */
function upperBound(entries: readonly LogEntry[], t: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].timestamp.getTime() <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildMatcher(search: string, regex: boolean): (text: string) => boolean {
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(search, "i");
    } catch (err) {
      throw new Error(`Invalid regular expression "${search}": ${(err as Error).message}`);
    }
    return (text) => re.test(text);
  }
  const term = search.toLowerCase();
  return (text) => text.toLowerCase().includes(term);
}
