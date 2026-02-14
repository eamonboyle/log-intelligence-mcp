import { createHash } from "node:crypto";
import { LogEntry, ErrorCluster } from "../types.js";

/**
 * Error fingerprinting & clustering engine.
 *
 * Algorithm:
 *  1. Strip variable tokens (UUIDs, hex, numbers, paths, URLs, IPs) from message
 *  2. Normalize whitespace & lowercase
 *  3. SHA-256 hash the normalized string → fingerprint
 *  4. Group entries by fingerprint → ErrorCluster
 */

// ── Regex patterns for variable token stripping ─────────────────────────────

// UUIDs: 550e8400-e29b-41d4-a716-446655440000
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Hex strings of 8+ chars (object IDs, hashes)
const HEX_RE = /\b[0-9a-f]{8,}\b/gi;

// Numbers (integers and decimals, including negative)
const NUMBER_RE = /\b-?\d+(?:\.\d+)?\b/g;

// IP addresses (v4)
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;

// URLs
const URL_RE = /https?:\/\/[^\s"']+/gi;

// File paths (Windows and Unix)
const PATH_RE = /(?:[a-zA-Z]:\\|\/)[^\s"':]+/g;

// ISO timestamps
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

// Quoted strings (often contain variable data)
const QUOTED_RE = /"[^"]*"|'[^']*'/g;

/**
 * Normalize an error message by stripping variable tokens.
 * Returns the normalized form used for fingerprinting.
 */
export function normalizeMessage(message: string): string {
  let normalized = message;

  // Order matters: replace more specific patterns first
  normalized = normalized.replace(TIMESTAMP_RE, "<TIMESTAMP>");
  normalized = normalized.replace(URL_RE, "<URL>");
  normalized = normalized.replace(IP_RE, "<IP>");
  normalized = normalized.replace(UUID_RE, "<UUID>");
  normalized = normalized.replace(PATH_RE, "<PATH>");
  normalized = normalized.replace(HEX_RE, "<HEX>");
  normalized = normalized.replace(QUOTED_RE, "<STR>");
  normalized = normalized.replace(NUMBER_RE, "<N>");

  // Collapse whitespace and lowercase
  normalized = normalized.replace(/\s+/g, " ").trim().toLowerCase();

  return normalized;
}

/**
 * Compute a fingerprint (SHA-256 hash) for a log message.
 */
export function fingerprint(message: string): string {
  const normalized = normalizeMessage(message);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Assign fingerprints to all entries that don't already have one.
 * Mutates entries in place.
 */
export function assignFingerprints(entries: LogEntry[]): void {
  for (const entry of entries) {
    if (!entry.fingerprint) {
      const text = entry.exception
        ? `${entry.message}\n${entry.exception.split("\n")[0]}`
        : entry.message;
      entry.fingerprint = fingerprint(text);
    }
  }
}

/**
 * Cluster error-level entries by fingerprint.
 * Returns clusters sorted by count (descending).
 */
export function clusterErrors(
  entries: LogEntry[],
  maxSamples: number = 3
): ErrorCluster[] {
  // Only cluster error-level entries
  const errorEntries = entries.filter(
    (e) => e.level === "error" || e.level === "fatal"
  );

  // Ensure all have fingerprints
  assignFingerprints(errorEntries);

  // Group by fingerprint
  const groups = new Map<string, LogEntry[]>();
  for (const entry of errorEntries) {
    const fp = entry.fingerprint!;
    if (!groups.has(fp)) {
      groups.set(fp, []);
    }
    groups.get(fp)!.push(entry);
  }

  // Build clusters
  const clusters: ErrorCluster[] = [];
  for (const [fp, group] of groups) {
    // Sort group by timestamp
    group.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const sources = [...new Set(group.map((e) => e.source))];

    clusters.push({
      fingerprint: fp,
      canonicalMessage: group[0].message,
      count: group.length,
      firstSeen: group[0].timestamp,
      lastSeen: group[group.length - 1].timestamp,
      samples: group.slice(0, maxSamples),
      sources,
    });
  }

  // Sort by count descending
  clusters.sort((a, b) => b.count - a.count);

  return clusters;
}
