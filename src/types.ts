// ── Log Levels ──────────────────────────────────────────────────────────────
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

// ── Core Log Entry ──────────────────────────────────────────────────────────
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  /** Rendered, human-readable message */
  message: string;
  /**
   * Message template (e.g. Serilog `@mt`) when the source provides one.
   * Preferred over `message` for fingerprinting because placeholders are
   * already normalised.
   */
  template?: string;
  exception?: string;
  properties: Record<string, unknown>;
  /** Source name (friendly name or file path) */
  source: string;
  /** Computed by the clustering engine */
  fingerprint?: string;
}

/** Result of an adapter ingest run */
export interface IngestResult {
  entries: LogEntry[];
  /** Lines or documents that could not be parsed into an entry */
  skipped: number;
  warnings: string[];
}

// ── Error Clustering ────────────────────────────────────────────────────────
export interface ErrorCluster {
  fingerprint: string;
  canonicalMessage: string; // representative (first-seen) message
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  samples: LogEntry[]; // up to maxSamples entries
  sources: string[]; // which sources contributed
}

// ── Anomaly Detection ───────────────────────────────────────────────────────
export interface AnomalyBucket {
  start: Date;
  end: Date;
  count: number;
  mean: number;
  stddev: number;
  zScore: number;
}

export interface AnomalyResult {
  fingerprint?: string; // if scoped to a specific cluster
  totalBuckets: number;
  anomalousBuckets: AnomalyBucket[];
  baselineMean: number;
  baselineStddev: number;
}

// ── Regression Detection ────────────────────────────────────────────────────
export interface IncreasedError {
  cluster: ErrorCluster;
  beforeRate: number; // errors per hour
  afterRate: number; // errors per hour
  /** afterRate / beforeRate; `null` when there was no baseline rate */
  increaseRatio: number | null;
}

export interface RegressionReport {
  deploymentDate: Date;
  beforeWindow: { start: Date; end: Date };
  afterWindow: { start: Date; end: Date };
  newErrors: ErrorCluster[]; // appeared only after deployment
  increasedErrors: IncreasedError[]; // existed before but spiked
  resolvedErrors: ErrorCluster[]; // disappeared after deployment
  summary: string;
}

// ── Adapter Types ───────────────────────────────────────────────────────────
export const ADAPTER_TYPES = ["serilog", "elastic", "sql", "flatfile"] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

export interface SourceConfig {
  name: string;
  type: AdapterType;
  /** File path. Optional only for live Elasticsearch queries. */
  path?: string;
  table?: string; // for SQL adapter
  filter?: string; // optional SQL WHERE or ES query_string
  pattern?: string; // regex pattern for flatfile
  endpoint?: string; // for live Elastic queries
  index?: string; // Elastic index name
  apiKey?: string; // Elastic API key (falls back to ELASTIC_API_KEY env var)
  limit?: number; // max docs to fetch from a live Elastic query (default 10000)
  timestampField?: string; // Elastic timestamp field used for sorting (default @timestamp)
}

export interface AppDefaults {
  bucketMinutes: number;
  anomalyThreshold: number;
  maxSamples: number;
}

export interface AppConfig {
  sources: SourceConfig[];
  defaults: AppDefaults;
}

export const DEFAULT_CONFIG: AppConfig = {
  sources: [],
  defaults: {
    bucketMinutes: 60,
    anomalyThreshold: 2.0,
    maxSamples: 3,
  },
};

// ── Timeline ────────────────────────────────────────────────────────────────
export interface TimelineBucket {
  start: Date;
  end: Date;
  count: number;
}

// ── Source Info ──────────────────────────────────────────────────────────────
export interface SourceInfo {
  name: string;
  type: AdapterType;
  entryCount: number;
  errorCount: number;
  timeRange: { earliest: Date; latest: Date } | null;
  ingestedAt: Date;
}

// ── Grouping ─────────────────────────────────────────────────────────────────
export interface GroupCount {
  value: string;
  count: number;
}
