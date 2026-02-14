import { LogEntry, AnomalyBucket, AnomalyResult } from "../types.js";

/**
 * Statistical anomaly / spike detection for error rates.
 *
 * Algorithm:
 *  1. Bucket entries into configurable time windows
 *  2. Calculate mean and standard deviation of bucket counts
 *  3. Flag buckets where count > mean + (threshold × stddev)
 *  4. A z-score is computed for each bucket: (count - mean) / stddev
 */

/**
 * Bucket entries into fixed-size time windows and calculate counts.
 */
function bucketize(
  entries: LogEntry[],
  bucketMs: number
): Array<{ start: number; end: number; count: number }> {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  const minTime = sorted[0].timestamp.getTime();
  const maxTime = sorted[sorted.length - 1].timestamp.getTime();

  const buckets: Array<{ start: number; end: number; count: number }> = [];
  let current = Math.floor(minTime / bucketMs) * bucketMs;

  while (current <= maxTime) {
    const start = current;
    const end = current + bucketMs;
    const count = sorted.filter(
      (e) => e.timestamp.getTime() >= start && e.timestamp.getTime() < end
    ).length;
    buckets.push({ start, end, count });
    current += bucketMs;
  }

  return buckets;
}

/**
 * Calculate mean and standard deviation of an array of numbers.
 */
function stats(values: number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 };

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);

  return { mean, stddev };
}

/**
 * Detect anomalous time buckets in log entries.
 *
 * @param entries - log entries to analyse (typically error-level only)
 * @param bucketMinutes - time window size in minutes (default 60)
 * @param threshold - z-score threshold for anomaly flagging (default 2.0)
 * @param fingerprint - optional: scope analysis to a specific error fingerprint
 */
export function detectAnomalies(
  entries: LogEntry[],
  bucketMinutes: number = 60,
  threshold: number = 2.0,
  fp?: string
): AnomalyResult {
  // Optionally filter by fingerprint
  let filtered = entries;
  if (fp) {
    filtered = entries.filter((e) => e.fingerprint === fp);
  }

  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = bucketize(filtered, bucketMs);
  const counts = buckets.map((b) => b.count);
  const { mean, stddev } = stats(counts);

  const anomalousBuckets: AnomalyBucket[] = [];

  for (const bucket of buckets) {
    const zScore = stddev > 0 ? (bucket.count - mean) / stddev : 0;

    if (bucket.count > mean + threshold * stddev && bucket.count > 0) {
      anomalousBuckets.push({
        start: new Date(bucket.start),
        end: new Date(bucket.end),
        count: bucket.count,
        mean,
        stddev,
        zScore,
      });
    }
  }

  // Sort by z-score descending
  anomalousBuckets.sort((a, b) => b.zScore - a.zScore);

  return {
    fingerprint: fp,
    totalBuckets: buckets.length,
    anomalousBuckets,
    baselineMean: Math.round(mean * 100) / 100,
    baselineStddev: Math.round(stddev * 100) / 100,
  };
}
