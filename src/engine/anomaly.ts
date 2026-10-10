import { bucketize, MINUTE_MS } from "../util/time.js";
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
 * Calculate population mean and standard deviation.
 */
export function stats(values: readonly number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 };

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Detect anomalous time buckets in log entries.
 *
 * @param entries - log entries to analyse (typically error-level only)
 * @param bucketMinutes - time window size in minutes (default 60)
 * @param threshold - z-score threshold for anomaly flagging (default 2.0)
 * @param fp - optional: scope analysis to a specific error fingerprint
 */
export function detectAnomalies(
  entries: readonly LogEntry[],
  bucketMinutes: number = 60,
  threshold: number = 2.0,
  fp?: string
): AnomalyResult {
  const filtered = fp ? entries.filter((e) => e.fingerprint === fp) : entries;

  const buckets = bucketize(filtered, bucketMinutes * MINUTE_MS);
  const { mean, stddev } = stats(buckets.map((b) => b.count));

  const anomalousBuckets: AnomalyBucket[] = [];
  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const zScore = stddev > 0 ? (bucket.count - mean) / stddev : 0;
    if (bucket.count > mean + threshold * stddev) {
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

  anomalousBuckets.sort((a, b) => b.zScore - a.zScore);

  return {
    fingerprint: fp,
    totalBuckets: buckets.length,
    anomalousBuckets,
    baselineMean: round2(mean),
    baselineStddev: round2(stddev),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
