import { z } from "zod";
import { AnomalyBucket, ErrorCluster, LogEntry, SourceInfo, TimelineBucket } from "./types.js";

/**
 * Shared presentation helpers: human-readable text for `content` and
 * JSON-safe objects (plus their zod schemas) for `structuredContent`.
 */

// ── Zod schemas for structured output ────────────────────────────────────────

export const EntryJsonSchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
  exception: z.string().optional(),
  source: z.string(),
  fingerprint: z.string().optional(),
  properties: z.record(z.string(), z.unknown()),
});

export const ClusterJsonSchema = z.object({
  fingerprint: z.string(),
  message: z.string(),
  count: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  sources: z.array(z.string()),
  exception: z.string().optional().describe("First line of the exception from the first sample"),
  samples: z.array(EntryJsonSchema),
});

export const TimelineBucketJsonSchema = z.object({
  start: z.string(),
  end: z.string(),
  count: z.number(),
});

export const AnomalyBucketJsonSchema = TimelineBucketJsonSchema.extend({
  zScore: z.number(),
});

export const SourceInfoJsonSchema = z.object({
  name: z.string(),
  type: z.string(),
  entryCount: z.number(),
  errorCount: z.number(),
  earliest: z.string().nullable(),
  latest: z.string().nullable(),
  ingestedAt: z.string(),
});

export type EntryJson = z.infer<typeof EntryJsonSchema>;
export type ClusterJson = z.infer<typeof ClusterJsonSchema>;

// ── JSON conversion ──────────────────────────────────────────────────────────

export function entryToJson(e: LogEntry): EntryJson {
  return {
    timestamp: e.timestamp.toISOString(),
    level: e.level,
    message: e.message,
    exception: e.exception,
    source: e.source,
    fingerprint: e.fingerprint,
    properties: e.properties,
  };
}

export function clusterToJson(c: ErrorCluster): ClusterJson {
  return {
    fingerprint: c.fingerprint,
    message: c.canonicalMessage,
    count: c.count,
    firstSeen: c.firstSeen.toISOString(),
    lastSeen: c.lastSeen.toISOString(),
    sources: c.sources,
    exception: firstLine(c.samples[0]?.exception),
    samples: c.samples.map(entryToJson),
  };
}

export function bucketToJson(b: TimelineBucket): z.infer<typeof TimelineBucketJsonSchema> {
  return { start: b.start.toISOString(), end: b.end.toISOString(), count: b.count };
}

export function anomalyToJson(b: AnomalyBucket): z.infer<typeof AnomalyBucketJsonSchema> {
  return { ...bucketToJson(b), zScore: round2(b.zScore) };
}

export function sourceInfoToJson(s: SourceInfo): z.infer<typeof SourceInfoJsonSchema> {
  return {
    name: s.name,
    type: s.type,
    entryCount: s.entryCount,
    errorCount: s.errorCount,
    earliest: s.timeRange?.earliest.toISOString() ?? null,
    latest: s.timeRange?.latest.toISOString() ?? null,
    ingestedAt: s.ingestedAt.toISOString(),
  };
}

// ── Text formatting ──────────────────────────────────────────────────────────

export function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.split("\n")[0].trim();
}

export function iso(d: Date): string {
  return d.toISOString();
}

/** Compact timestamp for tables: 2026-02-10T08:00:00 */
export function shortIso(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/** Multi-line description of a cluster, indented for lists. */
export function formatCluster(c: ErrorCluster, index?: number): string[] {
  const head = index !== undefined ? `#${index + 1} ` : "";
  const lines = [
    `${head}[${c.count}x] ${c.canonicalMessage}`,
    `    Fingerprint: ${c.fingerprint}`,
    `    First seen:  ${iso(c.firstSeen)}`,
    `    Last seen:   ${iso(c.lastSeen)}`,
    `    Sources:     ${c.sources.join(", ")}`,
  ];
  const ex = firstLine(c.samples[0]?.exception);
  if (ex) lines.push(`    Exception:   ${ex}`);
  return lines;
}

/** One-entry-per-block listing used by search and context tools. */
export function formatEntry(e: LogEntry): string[] {
  const lines = [`[${iso(e.timestamp)}] [${e.level.toUpperCase()}] ${e.message}`];
  const ex = firstLine(e.exception);
  if (ex) lines.push(`  Exception: ${ex}`);
  lines.push(`  Source: ${e.source} | Fingerprint: ${e.fingerprint ?? "N/A"}`);
  return lines;
}

/** ASCII bar chart of a timeline. */
export function formatTimeline(buckets: readonly TimelineBucket[], barWidth = 20): string[] {
  let maxCount = 0;
  for (const b of buckets) if (b.count > maxCount) maxCount = b.count;
  const lines = [
    "Time                | Count | Bar",
    "────────────────────┼───────┼" + "─".repeat(barWidth + 1),
  ];
  for (const b of buckets) {
    const barLen = maxCount > 0 ? Math.round((b.count / maxCount) * barWidth) : 0;
    lines.push(`${shortIso(b.start)} | ${String(b.count).padStart(5)} | ${"█".repeat(barLen)}`);
  }
  return lines;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
