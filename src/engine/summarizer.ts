import { isErrorEntry } from "../levels.js";
import { ErrorCluster, LogEntry } from "../types.js";
import { clusterErrors } from "./clustering.js";

/**
 * Error summarization engine.
 */

export interface ErrorSummary {
  totalErrors: number;
  uniquePatterns: number;
  /** Top-N clusters after the minCount filter */
  clusters: ErrorCluster[];
  /** Patterns that matched minCount but fell outside topN */
  truncated: number;
}

/**
 * Summarise error entries into clusters.
 *
 * @param entries - log entries to summarise (typically from store.errors())
 * @param topN - number of top clusters to include (default 10)
 * @param maxSamples - max sample entries per cluster (default 3)
 * @param minCount - minimum occurrences to include a cluster (default 1)
 */
export function summariseErrors(
  entries: readonly LogEntry[],
  topN: number = 10,
  maxSamples: number = 3,
  minCount: number = 1
): ErrorSummary {
  const clusters = clusterErrors(entries, maxSamples);
  const filtered = clusters.filter((c) => c.count >= minCount);
  const top = filtered.slice(0, topN);

  return {
    totalErrors: entries.filter(isErrorEntry).length,
    uniquePatterns: filtered.length,
    clusters: top,
    truncated: Math.max(0, filtered.length - top.length),
  };
}

/**
 * Detect error patterns present in a comparison window but absent in a baseline window.
 */
export function detectNewPatterns(
  baselineEntries: readonly LogEntry[],
  comparisonEntries: readonly LogEntry[],
  maxSamples: number = 3
): ErrorCluster[] {
  const baselineFingerprints = new Set(clusterErrors(baselineEntries, maxSamples).map((c) => c.fingerprint));
  return clusterErrors(comparisonEntries, maxSamples).filter((c) => !baselineFingerprints.has(c.fingerprint));
}
