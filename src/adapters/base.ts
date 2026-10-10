import { IngestResult, SourceConfig } from "../types.js";

/**
 * Base interface that all log source adapters must implement.
 */
export interface ILogAdapter {
  /** Adapter type identifier */
  readonly type: string;

  /**
   * Parse / fetch log entries from the configured source.
   * @param config - source configuration
   * @returns normalised entries plus parse statistics
   */
  ingest(config: SourceConfig): Promise<IngestResult>;
}

/** Throw a clear error when an adapter needs a file path and none was given. */
export function requirePath(config: SourceConfig, adapter: string): string {
  if (!config.path) {
    throw new Error(`The ${adapter} adapter requires a "path"`);
  }
  return config.path;
}
