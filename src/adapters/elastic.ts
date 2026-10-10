import { readFile } from "node:fs/promises";
import { ILogAdapter, requirePath } from "./base.js";
import { normalizeLevel } from "../levels.js";
import { asString, firstDefined, firstString } from "../util/object.js";
import { IngestResult, LogEntry, SourceConfig } from "../types.js";

/**
 * Parses Elasticsearch JSON dump files or queries a live Elasticsearch endpoint.
 *
 * Dump format: either a JSON array of `_source` docs, a full ES response with
 * `hits.hits[]._source`, or NDJSON (one doc per line).
 *
 * Live mode: issues POST to `{endpoint}/{index}/_search` with an optional
 * query_string filter. Authentication is taken from `config.apiKey`, or the
 * ELASTIC_API_KEY / ELASTIC_USERNAME + ELASTIC_PASSWORD environment variables.
 * Results are capped at `config.limit` (default 10000, the ES window limit).
 */

const TIMESTAMP_KEYS = ["@timestamp", "timestamp", "time", "date", "Timestamp"] as const;
const LEVEL_KEYS = ["level", "log.level", "severity", "loglevel", "Level"] as const;
// `log` is last because in ECS it is usually an object ({level, logger}); only string values are accepted
const MESSAGE_KEYS = ["message", "msg", "Message", "event.original", "log"] as const;
const EXCEPTION_KEYS = ["stack_trace", "error.stack_trace", "exception", "error.message", "Exception"] as const;

const RESERVED_KEYS = new Set<string>([...TIMESTAMP_KEYS, ...LEVEL_KEYS, ...MESSAGE_KEYS, ...EXCEPTION_KEYS]);

export const DEFAULT_ELASTIC_LIMIT = 10000;

type Doc = Record<string, unknown>;

export class ElasticAdapter implements ILogAdapter {
  readonly type = "elastic";

  async ingest(config: SourceConfig): Promise<IngestResult> {
    if (config.endpoint) {
      return this.ingestLive(config);
    }
    return this.ingestFile(config);
  }

  private async ingestFile(config: SourceConfig): Promise<IngestResult> {
    const path = requirePath(config, "elastic");
    const raw = await readFile(path, "utf-8");
    const trimmed = raw.trim();

    let docs: Doc[];
    let skipped = 0;

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        docs = this.docsFromParsed(parsed);
      } catch {
        // Not a single JSON document — fall back to NDJSON
        ({ docs, skipped } = this.parseNdjson(trimmed));
      }
    } else {
      ({ docs, skipped } = this.parseNdjson(trimmed));
    }

    return this.toResult(docs, skipped, config);
  }

  private docsFromParsed(parsed: unknown): Doc[] {
    if (Array.isArray(parsed)) {
      return parsed.map((d) => this.unwrapSource(d)).filter((d): d is Doc => d !== null);
    }
    if (parsed && typeof parsed === "object") {
      const hits = (parsed as { hits?: { hits?: unknown[] } }).hits?.hits;
      if (Array.isArray(hits)) {
        return hits.map((h) => this.unwrapSource(h)).filter((d): d is Doc => d !== null);
      }
      const single = this.unwrapSource(parsed);
      return single ? [single] : [];
    }
    return [];
  }

  private unwrapSource(value: unknown): Doc | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Doc;
    const source = obj["_source"];
    if (source && typeof source === "object" && !Array.isArray(source)) {
      return source as Doc;
    }
    return obj;
  }

  private parseNdjson(raw: string): { docs: Doc[]; skipped: number } {
    const docs: Doc[] = [];
    let skipped = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const doc = this.unwrapSource(JSON.parse(line));
        if (doc) docs.push(doc);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    return { docs, skipped };
  }

  private buildAuthHeaders(config: SourceConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const apiKey = config.apiKey ?? env.ELASTIC_API_KEY;
    if (apiKey) return { Authorization: `ApiKey ${apiKey}` };

    const user = env.ELASTIC_USERNAME;
    const pass = env.ELASTIC_PASSWORD;
    if (user && pass) {
      return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
    }
    return {};
  }

  private async ingestLive(config: SourceConfig): Promise<IngestResult> {
    const base = config.endpoint!.replace(/\/+$/, "");
    const index = encodeURIComponent(config.index ?? "*");
    // No ignore_unavailable: a mistyped index should fail loudly rather than ingest nothing
    const url = `${base}/${index}/_search`;
    const size = Math.min(config.limit ?? DEFAULT_ELASTIC_LIMIT, DEFAULT_ELASTIC_LIMIT);
    const tsField = config.timestampField ?? "@timestamp";

    const body: Record<string, unknown> = {
      size,
      track_total_hits: true, // otherwise ES caps hits.total at 10000 and truncation goes unnoticed
      sort: [{ [tsField]: { order: "desc", unmapped_type: "date" } }],
    };
    if (config.filter) {
      body.query = { query_string: { query: config.filter } };
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.buildAuthHeaders(config) },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `Elasticsearch query failed: ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`
      );
    }

    const data = (await resp.json()) as {
      hits?: { hits?: unknown[]; total?: number | { value: number; relation?: string } };
    };
    const hits = data.hits?.hits ?? [];
    const docs = hits.map((h) => this.unwrapSource(h)).filter((d): d is Doc => d !== null);
    const result = this.toResult(docs, hits.length - docs.length, config);

    const rawTotal = data.hits?.total;
    const total = typeof rawTotal === "object" ? rawTotal.value : rawTotal;
    const lowerBound = typeof rawTotal === "object" && rawTotal.relation === "gte";
    if (typeof total === "number" && (total > hits.length || lowerBound)) {
      result.warnings.push(
        `Only ${hits.length} of ${lowerBound ? "at least " : ""}${total} matching documents were fetched (limit ${size}); narrow the filter or raise "limit"`
      );
    }
    return result;
  }

  private toResult(docs: Doc[], skipped: number, config: SourceConfig): IngestResult {
    const entries: LogEntry[] = [];
    for (const doc of docs) {
      const entry = this.mapDoc(doc, config);
      if (entry) entries.push(entry);
      else skipped++;
    }
    const warnings: string[] = [];
    if (skipped > 0) warnings.push(`${skipped} document(s) lacked a timestamp or message and were skipped`);
    return { entries, skipped, warnings };
  }

  private mapDoc(doc: Doc, config: SourceConfig): LogEntry | null {
    const rawTs = firstDefined(doc, TIMESTAMP_KEYS);
    if (rawTs === undefined) return null;
    const timestamp = new Date(rawTs as string | number);
    if (Number.isNaN(timestamp.getTime())) return null;

    const level = normalizeLevel(firstDefined(doc, LEVEL_KEYS), "info");

    const message = firstString(doc, MESSAGE_KEYS);
    if (!message) return null;

    const exception = firstDefined(doc, EXCEPTION_KEYS);

    const properties: Doc = {};
    for (const [key, value] of Object.entries(doc)) {
      if (!RESERVED_KEYS.has(key)) properties[key] = value;
    }

    return {
      timestamp,
      level,
      message,
      exception: exception !== undefined ? asString(exception) : undefined,
      properties,
      source: config.name || config.path || config.endpoint || "elastic",
    };
  }
}
