import { LogEntry, SourceConfig } from "../types.js";

/**
 * Base interface that all log source adapters must implement.
 */
export interface ILogAdapter {
  /** Adapter type identifier */
  readonly type: string;

  /**
   * Parse / fetch log entries from the configured source.
   * @param config - source configuration
   * @returns array of normalised LogEntry objects
   */
  ingest(config: SourceConfig): Promise<LogEntry[]>;
}
