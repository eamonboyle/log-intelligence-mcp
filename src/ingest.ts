import { getAdapter } from "./adapters/index.js";
import { assignFingerprints } from "./engine/clustering.js";
import { LogStore } from "./engine/store.js";
import { isErrorEntry } from "./levels.js";
import { IngestResult, SourceConfig } from "./types.js";

export type IngestMode = "replace" | "append";

export interface IngestOutcome {
  result: IngestResult;
  /** Entries removed because the source was re-ingested in replace mode */
  replaced: number;
  errorCount: number;
}

/**
 * Ingest a source into the store: fetch via the adapter, fingerprint, and add.
 * In "replace" mode (the default) re-ingesting a source with the same name
 * drops the previous entries first so repeated loads do not double-count.
 */
export async function ingestSource(
  store: LogStore,
  config: SourceConfig,
  mode: IngestMode = "replace"
): Promise<IngestOutcome> {
  if (!config.path && !config.endpoint) {
    throw new Error(`Source "${config.name}" needs a path (or an endpoint for live Elasticsearch)`);
  }

  const adapter = getAdapter(config.type);
  const result = await adapter.ingest(config);
  assignFingerprints(result.entries);

  const replaced = mode === "replace" ? store.removeSource(config.name) : 0;
  store.add(result.entries, { name: config.name, type: config.type, config });

  return {
    result,
    replaced,
    errorCount: result.entries.filter(isErrorEntry).length,
  };
}
