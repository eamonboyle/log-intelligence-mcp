// ── Log Levels ──────────────────────────────────────────────────────────────
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

// ── Core Log Entry ──────────────────────────────────────────────────────────
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  exception?: string;
  properties: Record<string, unknown>;
  source: string; // adapter name or file path
  fingerprint?: string; // computed by clustering engine
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
  increaseRatio: number; // afterRate / beforeRate
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
export type AdapterType = "serilog" | "elastic" | "sql" | "flatfile";

export interface SourceConfig {
  name: string;
  type: AdapterType;
  path: string;
  table?: string; // for SQL adapter
  filter?: string; // optional SQL WHERE or property filter
  pattern?: string; // regex pattern for flatfile
  endpoint?: string; // for live Elastic queries
  index?: string; // Elastic index name
}

export interface AppConfig {
  sources: SourceConfig[];
  defaults: {
    bucketMinutes: number;
    anomalyThreshold: number;
    maxSamples: number;
  };
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
}
