/**
 * Raised when a tool receives an argument it cannot interpret. Tool wrappers
 * convert this into an `isError` result rather than crashing the request.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Parse an optional ISO-8601 date argument. Returns `undefined` when the value
 * is absent and throws a ToolInputError when it is present but unparseable.
 */
export function parseDateArg(value: string | undefined, name: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ToolInputError(
      `Invalid date for "${name}": "${value}". Use ISO 8601, e.g. 2026-02-10T08:00:00Z`
    );
  }
  return date;
}

/** Like parseDateArg but the argument is mandatory. */
export function requireDateArg(value: string, name: string): Date {
  const date = parseDateArg(value, name);
  if (!date) throw new ToolInputError(`"${name}" is required (ISO 8601)`);
  return date;
}

export interface CountBucket {
  start: number;
  end: number;
  count: number;
}

/** Upper bound on buckets a single timeline/anomaly call may produce. */
export const MAX_BUCKETS = 10_000;

/**
 * Bucket timestamped items into fixed windows aligned to multiples of
 * `bucketMs` since the epoch. Runs in O(n) and tolerates unsorted input.
 * Empty buckets between the first and last item are included.
 * Throws ToolInputError when the span / bucket size would exceed `maxBuckets`.
 */
export function bucketize<T extends { timestamp: Date }>(
  items: readonly T[],
  bucketMs: number,
  maxBuckets: number = MAX_BUCKETS
): CountBucket[] {
  if (items.length === 0 || bucketMs <= 0) return [];

  let min = Infinity;
  let max = -Infinity;
  for (const item of items) {
    const t = item.timestamp.getTime();
    if (t < min) min = t;
    if (t > max) max = t;
  }

  const firstStart = Math.floor(min / bucketMs) * bucketMs;
  const bucketCount = Math.floor((max - firstStart) / bucketMs) + 1;
  if (bucketCount > maxBuckets) {
    throw new ToolInputError(
      `This range would produce ${bucketCount.toLocaleString()} buckets (max ${maxBuckets.toLocaleString()}). Use a larger bucket size or a narrower date range.`
    );
  }
  const counts = new Array<number>(bucketCount).fill(0);

  for (const item of items) {
    const idx = Math.floor((item.timestamp.getTime() - firstStart) / bucketMs);
    counts[idx]++;
  }

  return counts.map((count, i) => ({
    start: firstStart + i * bucketMs,
    end: firstStart + (i + 1) * bucketMs,
    count,
  }));
}

export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
