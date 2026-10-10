/**
 * Read a value from an object by key, supporting both flat dotted keys
 * (`{"log.level": "error"}`) and nested paths (`{log: {level: "error"}}`).
 */
export function getPath(obj: Record<string, unknown>, path: string): unknown {
  if (path in obj) return obj[path];
  if (!path.includes(".")) return undefined;

  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Return the first defined value among several candidate paths. */
export function firstDefined(obj: Record<string, unknown>, paths: readonly string[]): unknown {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Return the first non-empty string value among several candidate paths (objects are not stringified). */
export function firstString(obj: Record<string, unknown>, paths: readonly string[]): string | undefined {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

/** Coerce an unknown value to a display string. */
export function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
