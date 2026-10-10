import { readFile } from "node:fs/promises";
import { ILogAdapter, requirePath } from "./base.js";
import { normalizeLevel } from "../levels.js";
import { IngestResult, LogEntry, SourceConfig } from "../types.js";

/**
 * Reads log entries from a SQLite database file using sql.js (WASM).
 *
 * Convention-based column mapping (case-insensitive):
 *   Timestamp / created_at / time / date   → timestamp
 *   Level / severity / loglevel            → level
 *   Message / msg / text / RenderedMessage → message
 *   Exception / error / stacktrace         → exception
 *
 * User can specify table name and optional WHERE filter.
 */

const TIMESTAMP_COLUMNS = ["timestamp", "created_at", "createdat", "time", "date", "logged", "@t"];
const LEVEL_COLUMNS = ["level", "severity", "loglevel", "@l"];
const MESSAGE_COLUMNS = ["message", "msg", "text", "renderedmessage", "@m", "@mt"];
const EXCEPTION_COLUMNS = ["exception", "error", "stacktrace", "stack_trace", "@x"];

/** Quote an identifier for SQLite, escaping embedded double quotes. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class SqlAdapter implements ILogAdapter {
  readonly type = "sql";

  async ingest(config: SourceConfig): Promise<IngestResult> {
    const path = requirePath(config, "sql");

    // Dynamic import so the sql.js WASM is only loaded when needed
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const buffer = await readFile(path);
    const db = new SQL.Database(new Uint8Array(buffer));

    const table = config.table || "Logs";
    let query = `SELECT * FROM ${quoteIdentifier(table)}`;
    if (config.filter) {
      query += ` WHERE ${config.filter}`;
    }
    query += " ORDER BY rowid";

    const entries: LogEntry[] = [];
    let skipped = 0;
    const warnings: string[] = [];

    try {
      const results = db.exec(query);
      if (results.length === 0) return { entries, skipped, warnings };

      const { columns, values } = results[0];
      const colMap = this.buildColumnMap(columns);
      const tsIdx = this.findColumn(colMap, TIMESTAMP_COLUMNS);
      if (tsIdx === undefined) {
        throw new Error(
          `Table "${table}" has no recognisable timestamp column (looked for ${TIMESTAMP_COLUMNS.join(", ")}). Columns: ${columns.join(", ")}`
        );
      }
      const levelIdx = this.findColumn(colMap, LEVEL_COLUMNS);
      const msgIdx = this.findColumn(colMap, MESSAGE_COLUMNS);
      if (msgIdx === undefined) {
        throw new Error(
          `Table "${table}" has no recognisable message column (looked for ${MESSAGE_COLUMNS.join(", ")}). Columns: ${columns.join(", ")}`
        );
      }
      const exIdx = this.findColumn(colMap, EXCEPTION_COLUMNS);
      const usedIdxs = new Set([tsIdx, levelIdx, msgIdx, exIdx].filter((i): i is number => i !== undefined));

      for (const row of values) {
        const entry = this.mapRow(row, columns, { tsIdx, levelIdx, msgIdx, exIdx, usedIdxs }, config);
        if (entry) entries.push(entry);
        else skipped++;
      }
    } finally {
      db.close();
    }

    if (skipped > 0) warnings.push(`${skipped} row(s) lacked a valid timestamp or message and were skipped`);
    return { entries, skipped, warnings };
  }

  private buildColumnMap(columns: string[]): Map<string, number> {
    const map = new Map<string, number>();
    columns.forEach((c, i) => map.set(c.toLowerCase(), i));
    return map;
  }

  private findColumn(colMap: Map<string, number>, candidates: string[]): number | undefined {
    for (const c of candidates) {
      const idx = colMap.get(c);
      if (idx !== undefined) return idx;
    }
    return undefined;
  }

  private mapRow(
    row: unknown[],
    columns: string[],
    idx: { tsIdx: number; levelIdx?: number; msgIdx: number; exIdx?: number; usedIdxs: Set<number> },
    config: SourceConfig
  ): LogEntry | null {
    const rawTs = row[idx.tsIdx];
    if (rawTs === null || rawTs === undefined || rawTs === "") return null;
    const timestamp = new Date(rawTs as string | number);
    if (Number.isNaN(timestamp.getTime())) return null;

    const level = normalizeLevel(idx.levelIdx !== undefined ? row[idx.levelIdx] : undefined, "info");

    const message = row[idx.msgIdx] == null ? "" : String(row[idx.msgIdx]);
    if (!message) return null;

    const rawEx = idx.exIdx !== undefined ? row[idx.exIdx] : undefined;
    const exception = rawEx == null || rawEx === "" ? undefined : String(rawEx);

    const properties: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      if (!idx.usedIdxs.has(i) && row[i] != null) {
        properties[columns[i]] = row[i];
      }
    }

    return {
      timestamp,
      level,
      message,
      exception,
      properties,
      source: config.name || config.path || "sql",
    };
  }
}
