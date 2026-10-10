import { createHash } from "node:crypto";
import { isErrorEntry } from "../levels.js";
import { LogEntry, ErrorCluster } from "../types.js";

/**
 * Error fingerprinting & clustering engine.
 *
 * Algorithm:
 *  1. Strip variable tokens (UUIDs, hex, numbers, paths, URLs, IPs) from message
 *  2. Normalize whitespace & lowercase
 *  3. SHA-256 hash the normalized string → fingerprint
 *  4. Group entries by fingerprint → ErrorCluster
 *
 * When an entry carries a message template (Serilog `@mt`) the template is
 * fingerprinted instead of the rendered message, since its placeholders are
 * already the "variable" parts.
 */

// ── Regex patterns for variable token stripping ─────────────────────────────

// UUIDs: 550e8400-e29b-41d4-a716-446655440000
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Hex strings of 8+ chars (object IDs, hashes)
const HEX_RE = /\b[0-9a-f]{8,}\b/gi;

// Any remaining word containing a digit: plain numbers, "30ms", "db2", "abc123def456", "E1234".
// Such tokens are almost always variable data (ids, counts, durations, hosts), so collapsing
// them lets messages that differ only in those values share a fingerprint.
const DIGIT_WORD_RE = /\b[\w-]*\d[\w-]*\b/g;

// IP addresses (v4) with optional port
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;

// URLs
const URL_RE = /https?:\/\/[^\s"']+/gi;

// Email addresses
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

// File paths (Windows and Unix)
const PATH_RE = /(?:[a-zA-Z]:\\|\/)[^\s"':]+/g;

// ISO timestamps
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

// Quoted strings (often contain variable data)
const QUOTED_RE = /"[^"]*"|'[^']*'/g;

// Serilog-style template holes: {UserId}, {@Order}, {Count:N0}
const TEMPLATE_HOLE_RE = /\{[@$]?[A-Za-z0-9_]+(?:[,:][^}]*)?\}/g;

/**
 * Normalize an error message by stripping variable tokens.
 * Returns the normalized form used for fingerprinting.
 */
export function normalizeMessage(message: string): string {
  let normalized = message;

  // Order matters: replace more specific patterns first
  normalized = normalized.replace(TEMPLATE_HOLE_RE, "<VAR>");
  normalized = normalized.replace(TIMESTAMP_RE, "<TIMESTAMP>");
  normalized = normalized.replace(URL_RE, "<URL>");
  normalized = normalized.replace(EMAIL_RE, "<EMAIL>");
  normalized = normalized.replace(IP_RE, "<IP>");
  normalized = normalized.replace(UUID_RE, "<UUID>");
  normalized = normalized.replace(PATH_RE, "<PATH>");
  normalized = normalized.replace(HEX_RE, "<N>"); // same token as DIGIT_WORD_RE so "abc123" and "xyz123" match
  normalized = normalized.replace(QUOTED_RE, "<STR>");
  normalized = normalized.replace(DIGIT_WORD_RE, "<N>");

  // Collapse whitespace and lowercase
  return normalized.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Compute a fingerprint (truncated SHA-256) for a log message.
 */
export function fingerprint(message: string): string {
  const normalized = normalizeMessage(message);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** The text an entry is fingerprinted on: template or message, plus first exception line. */
export function fingerprintText(entry: LogEntry): string {
  const base = entry.template ?? entry.message;
  if (!entry.exception) return base;
  return `${base}\n${entry.exception.split("\n")[0]}`;
}

/**
 * Assign fingerprints to all entries that don't already have one.
 * Mutates entries in place.
 */
export function assignFingerprints(entries: readonly LogEntry[]): void {
  for (const entry of entries) {
    if (!entry.fingerprint) {
      entry.fingerprint = fingerprint(fingerprintText(entry));
    }
  }
}

/**
 * Cluster error-level entries by fingerprint.
 * Returns clusters sorted by count (descending).
 */
export function clusterErrors(entries: readonly LogEntry[], maxSamples: number = 3): ErrorCluster[] {
  const errorEntries = entries.filter(isErrorEntry);
  assignFingerprints(errorEntries);

  const groups = new Map<string, LogEntry[]>();
  for (const entry of errorEntries) {
    const fp = entry.fingerprint!;
    const group = groups.get(fp);
    if (group) group.push(entry);
    else groups.set(fp, [entry]);
  }

  const clusters: ErrorCluster[] = [];
  for (const [fp, group] of groups) {
    group.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    clusters.push({
      fingerprint: fp,
      canonicalMessage: group[0].message,
      count: group.length,
      firstSeen: group[0].timestamp,
      lastSeen: group[group.length - 1].timestamp,
      samples: group.slice(0, maxSamples),
      sources: [...new Set(group.map((e) => e.source))],
    });
  }

  clusters.sort((a, b) => b.count - a.count || a.firstSeen.getTime() - b.firstSeen.getTime());
  return clusters;
}
