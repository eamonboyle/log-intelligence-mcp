import { readFile } from "node:fs/promises";
import { ILogAdapter } from "./base.js";
import { LogEntry, LogLevel, SourceConfig } from "../types.js";

/**
 * Parses Elasticsearch JSON dump files or queries a live Elasticsearch endpoint.
 *
 * Dump format: either a JSON array of `_source` docs, or an ES response with
 * `hits.hits[]._source` structure. Also supports NDJSON (one doc per line).
 *
 * Live mode: issues POST to `{endpoint}/{index}/_search` with optional filter.
 */
export class ElasticAdapter implements ILogAdapter {
  readonly type = "elastic";

  async ingest(config: SourceConfig): Promise<LogEntry[]> {
    if (config.endpoint) {
      return this.ingestLive(config);
    }
    return this.ingestFile(config);
  }

  private async ingestFile(config: SourceConfig): Promise<LogEntry[]> {
    const raw = await readFile(config.path, "utf-8");
    const trimmed = raw.trim();

    let docs: Record<string, unknown>[];

    // Try parsing as a full JSON document first
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          // Array of _source docs directly
          docs = parsed.map((d: Record<string, unknown>) =>
            d._source ? (d._source as Record<string, unknown>) : d
          );
        } else if (parsed.hits?.hits) {
          // Full ES response
          docs = (parsed.hits.hits as Array<{ _source: Record<string, unknown> }>).map(
            (h) => h._source
          );
        } else {
          // Single document
          docs = [parsed._source ? (parsed._source as Record<string, unknown>) : parsed];
        }
      } catch {
        // Fall back to NDJSON
        docs = this.parseNdjson(trimmed);
      }
    } else {
      docs = this.parseNdjson(trimmed);
    }

    return docs.map((d) => this.mapDoc(d, config)).filter((e): e is LogEntry => e !== null);
  }

  private parseNdjson(raw: string): Record<string, unknown>[] {
    return raw
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          return obj._source ? obj._source : obj;
        } catch {
          return null;
        }
      })
      .filter((d): d is Record<string, unknown> => d !== null);
  }

  private async ingestLive(config: SourceConfig): Promise<LogEntry[]> {
    const url = `${config.endpoint}/${config.index ?? "*"}/_search`;
    const body: Record<string, unknown> = {
      size: 10000,
      sort: [{ "@timestamp": { order: "desc" } }],
    };

    if (config.filter) {
      body.query = { query_string: { query: config.filter } };
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`Elasticsearch query failed: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as { hits: { hits: Array<{ _source: Record<string, unknown> }> } };
    return data.hits.hits
      .map((h) => this.mapDoc(h._source, config))
      .filter((e): e is LogEntry => e !== null);
  }

  private mapDoc(doc: Record<string, unknown>, config: SourceConfig): LogEntry | null {
    const rawTs = (doc["@timestamp"] ?? doc["timestamp"] ?? doc["date"]) as string | undefined;
    if (!rawTs) return null;
    const timestamp = new Date(rawTs);
    if (isNaN(timestamp.getTime())) return null;

    const rawLevel = (doc["level"] ?? doc["log.level"] ?? doc["severity"] ?? "info") as string;
    const level = this.mapLevel(rawLevel);

    const message = (doc["message"] ?? doc["msg"] ?? doc["log"] ?? "") as string;
    if (!message) return null;

    const exception = (doc["stack_trace"] ?? doc["error.stack_trace"] ?? doc["exception"]) as
      | string
      | undefined;

    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
      if (!["@timestamp", "timestamp", "date", "level", "log.level", "severity", "message", "msg", "log", "stack_trace", "error.stack_trace", "exception"].includes(key)) {
        properties[key] = value;
      }
    }

    return {
      timestamp,
      level,
      message,
      exception: exception || undefined,
      properties,
      source: config.name || config.path || config.endpoint || "elastic",
    };
  }

  private mapLevel(raw: string): LogLevel {
    const lower = raw.toLowerCase();
    const map: Record<string, LogLevel> = {
      trace: "trace",
      debug: "debug",
      info: "info",
      information: "info",
      warn: "warn",
      warning: "warn",
      error: "error",
      fatal: "fatal",
      critical: "fatal",
      emerg: "fatal",
    };
    return map[lower] ?? "info";
  }
}
