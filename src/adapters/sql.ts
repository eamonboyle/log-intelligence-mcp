import { ILogAdapter } from "./base.js";
import { LogEntry, LogLevel, SourceConfig } from "../types.js";

/**
 * Reads log entries from a SQLite database file using sql.js (WASM).
 *
 * Convention-based column mapping:
 *   Timestamp / timestamp / created_at → timestamp
 *   Level / level / severity           → level
 *   Message / message / msg            → message
 *   Exception / exception / error      → exception
 *
 * User can specify table name and optional WHERE filter.
 */
export class SqlAdapter implements ILogAdapter {
  readonly type = "sql";

  async ingest(config: SourceConfig): Promise<LogEntry[]> {
    // Dynamic import so sql.js WASM is only loaded when needed
    const initSqlJs = (await import("sql.js")).default;
    const { readFile } = await import("node:fs/promises");

    const SQL = await initSqlJs();
    const buffer = await readFile(config.path);
    const db = new SQL.Database(new Uint8Array(buffer));

    const table = config.table || "Logs";
    let query = `SELECT * FROM "${table}"`;
    if (config.filter) {
      query += ` WHERE ${config.filter}`;
    }
    query += " ORDER BY rowid";

    const entries: LogEntry[] = [];

    try {
      const results = db.exec(query);
      if (results.length === 0) return entries;

      const { columns, values } = results[0];
      const colMap = this.buildColumnMap(columns);

      for (const row of values) {
        const entry = this.mapRow(row, columns, colMap, config);
        if (entry) entries.push(entry);
      }
    } finally {
      db.close();
    }

    return entries;
  }

  private buildColumnMap(columns: string[]): Record<string, number> {
    const map: Record<string, number> = {};
    for (let i = 0; i < columns.length; i++) {
      map[columns[i].toLowerCase()] = i;
    }
    return map;
  }

  private findColumn(colMap: Record<string, number>, ...candidates: string[]): number | undefined {
    for (const c of candidates) {
      if (colMap[c] !== undefined) return colMap[c];
    }
    return undefined;
  }

  private mapRow(
    row: unknown[],
    columns: string[],
    colMap: Record<string, number>,
    config: SourceConfig
  ): LogEntry | null {
    const tsIdx = this.findColumn(colMap, "timestamp", "created_at", "time", "date", "@t");
    if (tsIdx === undefined) return null;

    const rawTs = row[tsIdx];
    if (!rawTs) return null;
    const timestamp = new Date(rawTs as string | number);
    if (isNaN(timestamp.getTime())) return null;

    const levelIdx = this.findColumn(colMap, "level", "severity", "loglevel", "@l");
    const rawLevel = levelIdx !== undefined ? String(row[levelIdx]) : "info";
    const level = this.mapLevel(rawLevel);

    const msgIdx = this.findColumn(colMap, "message", "msg", "text", "renderedmessage", "@m", "@mt");
    const message = msgIdx !== undefined ? String(row[msgIdx] ?? "") : "";
    if (!message) return null;

    const exIdx = this.findColumn(colMap, "exception", "error", "stacktrace", "stack_trace", "@x");
    const exception = exIdx !== undefined ? (row[exIdx] ? String(row[exIdx]) : undefined) : undefined;

    // Remaining columns as properties
    const properties: Record<string, unknown> = {};
    const usedIdxs = new Set(
      [tsIdx, levelIdx, msgIdx, exIdx].filter((i) => i !== undefined)
    );
    for (let i = 0; i < columns.length; i++) {
      if (!usedIdxs.has(i) && row[i] != null) {
        properties[columns[i]] = row[i];
      }
    }

    return {
      timestamp,
      level,
      message,
      exception,
      properties,
      source: config.name || config.path,
    };
  }

  private mapLevel(raw: string): LogLevel {
    const lower = raw.toLowerCase();
    const map: Record<string, LogLevel> = {
      trace: "trace",
      verbose: "trace",
      debug: "debug",
      information: "info",
      info: "info",
      warning: "warn",
      warn: "warn",
      error: "error",
      fatal: "fatal",
      critical: "fatal",
    };
    return map[lower] ?? "info";
  }
}
