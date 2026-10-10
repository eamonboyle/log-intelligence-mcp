import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLevel, isErrorLevel } from "../src/levels.js";

test("normalizeLevel maps common spellings", () => {
  assert.equal(normalizeLevel("Information"), "info");
  assert.equal(normalizeLevel("WARNING"), "warn");
  assert.equal(normalizeLevel("Verbose"), "trace");
  assert.equal(normalizeLevel("critical"), "fatal");
  assert.equal(normalizeLevel("err"), "error");
  assert.equal(normalizeLevel("emerg"), "fatal");
});

test("normalizeLevel handles numeric pino levels but not ambiguous small integers", () => {
  assert.equal(normalizeLevel(50), "error");
  assert.equal(normalizeLevel(60), "fatal");
  assert.equal(normalizeLevel("30"), "info");
  assert.equal(normalizeLevel(10), "trace");
  // 0..7 is syslog (0 = most severe) for some sources and .NET LogLevel (0 = least severe) for others
  assert.equal(normalizeLevel(0), "info");
  assert.equal(normalizeLevel(3), "info");
});

test("normalizeLevel falls back for unknown values", () => {
  assert.equal(normalizeLevel("banana"), "info");
  assert.equal(normalizeLevel(undefined), "info");
  assert.equal(normalizeLevel(null, "warn"), "warn");
  assert.equal(normalizeLevel(""), "info");
});

test("isErrorLevel", () => {
  assert.equal(isErrorLevel("error"), true);
  assert.equal(isErrorLevel("fatal"), true);
  assert.equal(isErrorLevel("warn"), false);
});
