import { ILogAdapter, requirePath } from "./base.js";
import { readLines } from "./lines.js";
import { normalizeLevel } from "../levels.js";
import { asString, firstDefined } from "../util/object.js";
import { IngestResult, LogEntry, SourceConfig } from "../types.js";

/**
 * Parses Serilog Compact Log Event Format (.clef) and standard Serilog JSON files.
 *
 * CLEF format fields:
 *   @t  – timestamp (ISO 8601)
 *   @l  – level (Verbose/Debug/Information/Warning/Error/Fatal); absent means Information
 *   @mt – message template
 *   @m  – rendered message (optional; rendered from @mt + properties when absent)
 *   @x  – exception
 *   @i  – event id
 *   @r  – renderings
 *   ...rest are properties
 */

const TIMESTAMP_KEYS = ["@t", "Timestamp", "timestamp"] as const;
const LEVEL_KEYS = ["@l", "Level", "level"] as const;
const RENDERED_KEYS = ["@m", "RenderedMessage", "message"] as const;
const TEMPLATE_KEYS = ["@mt", "MessageTemplate", "messageTemplate"] as const;
const EXCEPTION_KEYS = ["@x", "Exception", "exception"] as const;

const RESERVED_KEYS = new Set<string>([
  ...TIMESTAMP_KEYS,
  ...LEVEL_KEYS,
  ...RENDERED_KEYS,
  ...TEMPLATE_KEYS,
  ...EXCEPTION_KEYS,
  "@i",
  "@r",
  "@tr",
  "@sp",
  "Properties",
]);

// {Name}, {@Name}, {$Name}, {Name:format}, {Name,alignment}
const TEMPLATE_HOLE_RE = /\{[@$]?([A-Za-z0-9_]+)(?:[,:][^}]*)?\}/g;

/**
 * Render a Serilog message template using the event's properties.
 * Unknown placeholders are left in place.
 */
export function renderMessageTemplate(template: string, properties: Record<string, unknown>): string {
  return template.replace(TEMPLATE_HOLE_RE, (whole, name: string) => {
    if (!(name in properties)) return whole;
    return asString(properties[name]);
  });
}

export class SerilogAdapter implements ILogAdapter {
  readonly type = "serilog";

  async ingest(config: SourceConfig): Promise<IngestResult> {
    const path = requirePath(config, "serilog");
    const entries: LogEntry[] = [];
    let skipped = 0;

    for await (const line of readLines(path)) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        skipped++;
        continue;
      }
      const entry = this.parseEvent(obj as Record<string, unknown>, config);
      if (entry) entries.push(entry);
      else skipped++;
    }

    const warnings: string[] = [];
    if (skipped > 0) warnings.push(`${skipped} line(s) could not be parsed as Serilog events`);
    return { entries, skipped, warnings };
  }

  private parseEvent(obj: Record<string, unknown>, config: SourceConfig): LogEntry | null {
    const rawTs = firstDefined(obj, TIMESTAMP_KEYS);
    if (rawTs === undefined) return null;
    const timestamp = new Date(rawTs as string | number);
    if (Number.isNaN(timestamp.getTime())) return null;

    // In CLEF an absent @l means Information
    const level = normalizeLevel(firstDefined(obj, LEVEL_KEYS), "info");

    // Properties: CLEF puts them at the top level; classic Serilog JSON nests them under "Properties"
    const properties: Record<string, unknown> = {};
    const nested = obj["Properties"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(properties, nested as Record<string, unknown>);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (!RESERVED_KEYS.has(key)) properties[key] = value;
    }

    const template = firstDefined(obj, TEMPLATE_KEYS);
    const rendered = firstDefined(obj, RENDERED_KEYS);

    let message: string;
    if (rendered !== undefined) {
      message = asString(rendered);
    } else if (template !== undefined) {
      message = renderMessageTemplate(asString(template), properties);
    } else {
      return null;
    }
    if (!message) return null;

    const exception = firstDefined(obj, EXCEPTION_KEYS);

    return {
      timestamp,
      level,
      message,
      template: template !== undefined ? asString(template) : undefined,
      exception: exception !== undefined ? asString(exception) : undefined,
      properties,
      source: config.name || path_(config),
    };
  }
}

function path_(config: SourceConfig): string {
  return config.path ?? "serilog";
}
