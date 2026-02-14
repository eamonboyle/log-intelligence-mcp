import { ErrorCluster, LogEntry } from "../types.js";
import { clusterErrors, assignFingerprints } from "./clustering.js";

/**
 * Error summarization engine.
 *
 * Builds human-readable summaries of error clusters, including:
 *  - Top-N clusters by frequency
 *  - Time span (first seen → last seen)
 *  - Affected sources
 *  - Representative sample messages
 */

export interface ErrorSummary {
  totalErrors: number;
  uniquePatterns: number;
  clusters: ErrorCluster[];
  text: string; // human-readable summary
}

/**
 * Summarise error entries into clusters with a human-readable report.
 *
 * @param entries - log entries to summarise (typically from store.errors())
 * @param topN - number of top clusters to include (default 10)
 * @param maxSamples - max sample entries per cluster (default 3)
 * @param minCount - minimum occurrences to include a cluster (default 1)
 */
export function summariseErrors(
  entries: LogEntry[],
  topN: number = 10,
  maxSamples: number = 3,
  minCount: number = 1
): ErrorSummary {
  assignFingerprints(entries);
  const clusters = clusterErrors(entries, maxSamples);

  // Filter by minimum count
  const filtered = clusters.filter((c) => c.count >= minCount);

  // Take top N
  const top = filtered.slice(0, topN);

  // Build text summary
  const lines: string[] = [];
  lines.push(`Error Summary: ${filtered.length} unique pattern(s), ${entries.filter((e) => e.level === "error" || e.level === "fatal").length} total error(s)`);
  lines.push("");

  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    lines.push(`#${i + 1} [${c.count}x] ${c.canonicalMessage}`);
    lines.push(`    Fingerprint: ${c.fingerprint}`);
    lines.push(`    First seen:  ${c.firstSeen.toISOString()}`);
    lines.push(`    Last seen:   ${c.lastSeen.toISOString()}`);
    lines.push(`    Sources:     ${c.sources.join(", ")}`);

    if (c.samples[0]?.exception) {
      const firstLine = c.samples[0].exception.split("\n")[0];
      lines.push(`    Exception:   ${firstLine}`);
    }

    lines.push("");
  }

  if (filtered.length > topN) {
    lines.push(`... and ${filtered.length - topN} more pattern(s)`);
  }

  return {
    totalErrors: entries.filter((e) => e.level === "error" || e.level === "fatal").length,
    uniquePatterns: filtered.length,
    clusters: top,
    text: lines.join("\n"),
  };
}

/**
 * Detect error patterns present in a comparison window but absent in a baseline window.
 *
 * @param baselineEntries - entries from the baseline period
 * @param comparisonEntries - entries from the comparison period
 * @param maxSamples - max sample entries per cluster
 */
export function detectNewPatterns(
  baselineEntries: LogEntry[],
  comparisonEntries: LogEntry[],
  maxSamples: number = 3
): ErrorCluster[] {
  assignFingerprints(baselineEntries);
  assignFingerprints(comparisonEntries);

  const baselineClusters = clusterErrors(baselineEntries, maxSamples);
  const comparisonClusters = clusterErrors(comparisonEntries, maxSamples);

  const baselineFingerprints = new Set(baselineClusters.map((c) => c.fingerprint));

  // New patterns = in comparison but not in baseline
  return comparisonClusters.filter((c) => !baselineFingerprints.has(c.fingerprint));
}
