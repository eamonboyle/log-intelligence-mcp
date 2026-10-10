import { HOUR_MS } from "../util/time.js";
import { LogEntry, ErrorCluster, RegressionReport, IncreasedError } from "../types.js";
import { clusterErrors } from "./clustering.js";

/**
 * Regression detection: compare error patterns before and after a deployment date.
 *
 * Algorithm:
 *  1. Split entries at deploymentDate into "before" and "after" windows
 *  2. Cluster errors in each window independently
 *  3. Set-diff fingerprints: new = afterOnly, resolved = beforeOnly
 *  4. For shared fingerprints, compare hourly rates; flag if afterRate > increaseFactor × beforeRate
 */

export interface RegressionOptions {
  /** Hours before deployment to use as the baseline (default 168 = 1 week) */
  hoursBefore?: number;
  /** Hours after deployment to analyse (default 24) */
  hoursAfter?: number;
  /** Max sample entries per cluster (default 3) */
  maxSamples?: number;
  /** An existing error is "increased" when afterRate > increaseFactor × beforeRate (default 2) */
  increaseFactor?: number;
}

function hourlyRate(count: number, windowMs: number): number {
  const hours = windowMs / HOUR_MS;
  return hours <= 0 ? 0 : count / hours;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Detect regressions around a deployment date.
 */
export function detectRegression(
  entries: readonly LogEntry[],
  deploymentDate: Date,
  options: RegressionOptions = {}
): RegressionReport {
  const hoursBefore = options.hoursBefore ?? 168;
  const hoursAfter = options.hoursAfter ?? 24;
  const maxSamples = options.maxSamples ?? 3;
  const increaseFactor = options.increaseFactor ?? 2;

  const deployMs = deploymentDate.getTime();
  const beforeStart = new Date(deployMs - hoursBefore * HOUR_MS);
  const afterEnd = new Date(deployMs + hoursAfter * HOUR_MS);

  const beforeEntries: LogEntry[] = [];
  const afterEntries: LogEntry[] = [];
  for (const e of entries) {
    const t = e.timestamp.getTime();
    if (t >= beforeStart.getTime() && t < deployMs) beforeEntries.push(e);
    else if (t >= deployMs && t <= afterEnd.getTime()) afterEntries.push(e);
  }

  const beforeMap = new Map(clusterErrors(beforeEntries, maxSamples).map((c) => [c.fingerprint, c]));
  const afterMap = new Map(clusterErrors(afterEntries, maxSamples).map((c) => [c.fingerprint, c]));

  const beforeWindowMs = deployMs - beforeStart.getTime();
  const afterWindowMs = afterEnd.getTime() - deployMs;

  const newErrors: ErrorCluster[] = [];
  const increasedErrors: IncreasedError[] = [];
  for (const [fp, afterCluster] of afterMap) {
    const beforeCluster = beforeMap.get(fp);
    if (!beforeCluster) {
      newErrors.push(afterCluster);
      continue;
    }
    // Compare on exact rates; round only for presentation so rare baselines are not treated as zero
    const beforeRate = hourlyRate(beforeCluster.count, beforeWindowMs);
    const afterRate = hourlyRate(afterCluster.count, afterWindowMs);
    if (afterRate > 0 && afterRate > beforeRate * increaseFactor) {
      increasedErrors.push({
        cluster: afterCluster,
        beforeRate: round2(beforeRate),
        afterRate: round2(afterRate),
        increaseRatio: beforeRate > 0 ? round2(afterRate / beforeRate) : null,
      });
    }
  }

  const resolvedErrors: ErrorCluster[] = [];
  for (const [fp, cluster] of beforeMap) {
    if (!afterMap.has(fp)) resolvedErrors.push(cluster);
  }

  newErrors.sort((a, b) => b.count - a.count);
  increasedErrors.sort((a, b) => (b.increaseRatio ?? Infinity) - (a.increaseRatio ?? Infinity));
  resolvedErrors.sort((a, b) => b.count - a.count);

  const parts: string[] = [];
  if (newErrors.length > 0) parts.push(`${newErrors.length} new error pattern(s) appeared after deployment`);
  if (increasedErrors.length > 0) parts.push(`${increasedErrors.length} existing error(s) increased in frequency`);
  if (resolvedErrors.length > 0) parts.push(`${resolvedErrors.length} error pattern(s) resolved after deployment`);
  if (parts.length === 0) parts.push("No significant regressions detected after deployment");

  return {
    deploymentDate,
    beforeWindow: { start: beforeStart, end: deploymentDate },
    afterWindow: { start: deploymentDate, end: afterEnd },
    newErrors,
    increasedErrors,
    resolvedErrors,
    summary: parts.join(". ") + ".",
  };
}
