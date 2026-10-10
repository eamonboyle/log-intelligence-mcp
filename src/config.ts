import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ADAPTER_TYPES, AppConfig, DEFAULT_CONFIG, SourceConfig } from "./types.js";

export const CONFIG_FILENAME = "log-intelligence.config.json";
export const CONFIG_ENV_VAR = "LOG_INTELLIGENCE_CONFIG";

const SourceConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(ADAPTER_TYPES),
    path: z.string().min(1).optional(),
    table: z.string().optional(),
    filter: z.string().optional(),
    pattern: z.string().optional(),
    endpoint: z.string().url().optional(),
    index: z.string().optional(),
    apiKey: z.string().optional(),
    limit: z.number().int().positive().optional(),
    timestampField: z.string().optional(),
  })
  .refine((s) => s.path || s.endpoint, {
    message: "a source needs either a path or an endpoint",
  });

const DefaultsSchema = z.object({
  bucketMinutes: z.number().positive().optional(),
  anomalyThreshold: z.number().positive().optional(),
  maxSamples: z.number().int().positive().optional(),
});

const AppConfigSchema = z.object({
  sources: z.array(SourceConfigSchema).optional(),
  defaults: DefaultsSchema.optional(),
});

export interface LoadedConfig {
  config: AppConfig;
  /** Absolute path of the file that was loaded, if any */
  path?: string;
  warnings: string[];
}

/**
 * Work out where the config file should be read from.
 * Precedence: explicit argument → LOG_INTELLIGENCE_CONFIG env var → ./log-intelligence.config.json
 */
export function resolveConfigPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): {
  path: string;
  explicit: boolean;
} {
  if (explicit) return { path: resolve(explicit), explicit: true };
  const fromEnv = env[CONFIG_ENV_VAR];
  if (fromEnv) return { path: resolve(fromEnv), explicit: true };
  return { path: resolve(process.cwd(), CONFIG_FILENAME), explicit: false };
}

/**
 * Validate raw JSON and turn it into a full AppConfig. Relative source paths
 * are resolved against `baseDir` so a config file works regardless of the
 * working directory the MCP client launches the server with.
 */
export function parseConfig(raw: unknown, baseDir: string): AppConfig {
  const parsed = AppConfigSchema.parse(raw);

  const sources: SourceConfig[] = (parsed.sources ?? []).map((s) => ({
    ...s,
    path: s.path && !isAbsolute(s.path) ? resolve(baseDir, s.path) : s.path,
    // The operator wrote this endpoint, so environment credentials may go to it
    allowEnvCredentials: true,
  }));

  return {
    sources,
    defaults: {
      bucketMinutes: parsed.defaults?.bucketMinutes ?? DEFAULT_CONFIG.defaults.bucketMinutes,
      anomalyThreshold: parsed.defaults?.anomalyThreshold ?? DEFAULT_CONFIG.defaults.anomalyThreshold,
      maxSamples: parsed.defaults?.maxSamples ?? DEFAULT_CONFIG.defaults.maxSamples,
    },
  };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`)
    .join("; ");
}

/**
 * Load the optional configuration file.
 *
 * - A missing default config file is not an error.
 * - A missing explicitly requested file (flag or env var) throws.
 * - An unreadable or invalid file falls back to defaults and reports a warning
 *   so the problem is visible instead of silently ignored.
 */
export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const { path, explicit } = resolveConfigPath(explicitPath);
  const warnings: string[] = [];

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !explicit) {
      return { config: structuredClone(DEFAULT_CONFIG), warnings };
    }
    throw new Error(`Cannot read config file ${path}: ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    warnings.push(`Config file ${path} is not valid JSON (${(err as Error).message}); using defaults`);
    return { config: structuredClone(DEFAULT_CONFIG), path, warnings };
  }

  try {
    return { config: parseConfig(json, dirname(path)), path, warnings };
  } catch (err) {
    const detail = err instanceof z.ZodError ? formatZodError(err) : (err as Error).message;
    warnings.push(`Config file ${path} is invalid (${detail}); using defaults`);
    return { config: structuredClone(DEFAULT_CONFIG), path, warnings };
  }
}
