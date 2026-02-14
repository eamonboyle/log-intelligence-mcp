import { LogEntry, ErrorCluster, RegressionReport, IncreasedError } from "../types.js";
import { clusterErrors, assignFingerprints } from "./clustering.js";

/**
 * Regression detection: compare error patterns before and after a deployment date.
 *
 * Algorithm:
 *  1. Split entries at deploymentDate into "before" and "after" windows
 *  2. Cluster errors in each window independently
 *  3. Set-diff fingerprints: new = afterOnly, resolved = beforeOnly
 *  4. For shared fingerprints, compare hourly rates; flag if afterRate > 2× beforeRate
 */

/**
 * Calculate error rate per hour for a set of entries within a time window.
 */
function hourlyRate(count: number, windowMs: number): number {
  const hours = windowMs / (60 * 60 * 1000);
  if (hours <= 0) return 0;
  return Math.round((count / hours) * 100) / 100;
}

/**
 * Detect regressions around a deployment date.
 *
 * @param entries - all log entries (store.all())
 * @param deploymentDate - the deployment timestamp
 * @param hoursBefore - how many hours before deployment to consider as baseline (default 168 = 1 week)
 * @param hoursAfter - how many hours after deployment to analyse (default 24)
 * @param maxSamples - max sample entries per cluster (default 3)
 */
export function detectRegression(
  entries: LogEntry[],
  deploymentDate: Date,
  hoursBefore: number = 168,
  hoursAfter: number = 24,
  maxSamples: number = 3
): RegressionReport {
  const deployMs = deploymentDate.getTime();
  const beforeStart = new Date(deployMs - hoursBefore * 60 * 60 * 1000);
  const afterEnd = new Date(deployMs + hoursAfter * 60 * 60 * 1000);

  // Split entries into before and after windows
  const beforeEntries = entries.filter(
    (e) =>
      e.timestamp.getTime() >= beforeStart.getTime() &&
      e.timestamp.getTime() < deployMs
  );
  const afterEntries = entries.filter(
    (e) =>
      e.timestamp.getTime() >= deployMs &&
      e.timestamp.getTime() <= afterEnd.getTime()
  );

  // Assign fingerprints
  assignFingerprints(beforeEntries);
  assignFingerprints(afterEntries);

  // Cluster each window
  const beforeClusters = clusterErrors(beforeEntries, maxSamples);
  const afterClusters = clusterErrors(afterEntries, maxSamples);

  // Build fingerprint maps
  const beforeMap = new Map<string, ErrorCluster>();
  for (const c of beforeClusters) {
    beforeMap.set(c.fingerprint, c);
  }

  const afterMap = new Map<string, ErrorCluster>();
  for (const c of afterClusters) {
    afterMap.set(c.fingerprint, c);
  }

  // Compute time windows in ms
  const beforeWindowMs = deployMs - beforeStart.getTime();
  const afterWindowMs = afterEnd.getTime() - deployMs;

  // New errors: in after but not in before
  const newErrors: ErrorCluster[] = [];
  for (const [fp, cluster] of afterMap) {
    if (!beforeMap.has(fp)) {
      newErrors.push(cluster);
    }
  }

  // Resolved errors: in before but not in after
  const resolvedErrors: ErrorCluster[] = [];
  for (const [fp, cluster] of beforeMap) {
    if (!afterMap.has(fp)) {
      resolvedErrors.push(cluster);
    }
  }

  // Increased errors: in both, but rate increased significantly
  const increasedErrors: IncreasedError[] = [];
  for (const [fp, afterCluster] of afterMap) {
    const beforeCluster = beforeMap.get(fp);
    if (beforeCluster) {
      const beforeRate = hourlyRate(beforeCluster.count, beforeWindowMs);
      const afterRate = hourlyRate(afterCluster.count, afterWindowMs);

      if (afterRate > beforeRate * 2 && afterRate > 0) {
        increasedErrors.push({
          cluster: afterCluster,
          beforeRate,
          afterRate,
          increaseRatio: beforeRate > 0 ? Math.round((afterRate / beforeRate) * 100) / 100 : Infinity,
        });
      }
    }
  }

  // Sort by severity
  newErrors.sort((a, b) => b.count - a.count);
  increasedErrors.sort((a, b) => b.increaseRatio - a.increaseRatio);
  resolvedErrors.sort((a, b) => b.count - a.count);

  // Build summary
  const parts: string[] = [];
  if (newErrors.length > 0) {
    parts.push(`${newErrors.length} new error pattern(s) appeared after deployment`);
  }
  if (increasedErrors.length > 0) {
    parts.push(`${increasedErrors.length} existing error(s) increased in frequency`);
  }
  if (resolvedErrors.length > 0) {
    parts.push(`${resolvedErrors.length} error pattern(s) resolved after deployment`);
  }
  if (parts.length === 0) {
    parts.push("No significant regressions detected after deployment");
  }

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
