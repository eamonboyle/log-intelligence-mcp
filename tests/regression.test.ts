import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRegression } from "../src/engine/regression.js";
import { series } from "./helpers.js";

const DEPLOY = new Date("2026-01-08T00:00:00Z");

test("detectRegression classifies new, increased and resolved errors", () => {
  const entries = [
    // "old" error: 24 in the week before (~0.14/hr), 0 after → resolved
    ...series("2026-01-01T01:00:00Z", 24, 360, "error", "Legacy widget failed"),
    // "steady" error: 168 before (1/hr), 24 after (1/hr) → unchanged
    ...series("2026-01-01T00:30:00Z", 168, 60, "error", "Cache miss storm"),
    ...series("2026-01-08T00:30:00Z", 24, 60, "error", "Cache miss storm"),
    // "worse" error: 7 before (0.04/hr), 20 after (0.83/hr) → increased
    ...series("2026-01-01T12:00:00Z", 7, 1440, "error", "Payment declined for order 1"),
    ...series("2026-01-08T01:00:00Z", 20, 30, "error", "Payment declined for order 2"),
    // "new" error: only after
    ...series("2026-01-08T02:00:00Z", 5, 10, "error", "Redis connection refused"),
  ];

  const report = detectRegression(entries, DEPLOY, { hoursBefore: 168, hoursAfter: 24 });

  assert.deepEqual(report.newErrors.map((c) => c.canonicalMessage), ["Redis connection refused"]);
  assert.deepEqual(report.resolvedErrors.map((c) => c.canonicalMessage), ["Legacy widget failed"]);
  assert.equal(report.increasedErrors.length, 1);
  const inc = report.increasedErrors[0];
  assert.equal(inc.cluster.canonicalMessage, "Payment declined for order 2");
  assert.ok(inc.afterRate > inc.beforeRate * 2);
  assert.ok(inc.increaseRatio !== null && inc.increaseRatio > 2);
  assert.match(report.summary, /1 new error pattern/);
  assert.match(report.summary, /1 existing error/);
  assert.match(report.summary, /1 error pattern\(s\) resolved/);
});

test("detectRegression respects the window bounds", () => {
  const entries = [
    ...series("2025-12-01T00:00:00Z", 10, 60, "error", "Ancient"), // outside hoursBefore
    ...series("2026-01-10T00:00:00Z", 10, 60, "error", "Far future"), // outside hoursAfter
  ];
  const report = detectRegression(entries, DEPLOY, { hoursBefore: 168, hoursAfter: 24 });
  assert.equal(report.newErrors.length, 0);
  assert.equal(report.resolvedErrors.length, 0);
  assert.equal(report.increasedErrors.length, 0);
  assert.match(report.summary, /No significant regressions/);
});

test("a rare baseline is not mistaken for a brand-new error", () => {
  // one hit 20 days before, one hit 1h after, 30-day baseline: 1/720 h ≈ 0.0014/h before vs 1/24 h after
  const entries = [
    ...series("2025-12-19T00:00:00Z", 1, 60, "error", "Rare"),
    ...series("2026-01-08T01:00:00Z", 1, 60, "error", "Rare"),
  ];
  const report = detectRegression(entries, DEPLOY, { hoursBefore: 720, hoursAfter: 24 });
  assert.equal(report.newErrors.length, 0);
  assert.equal(report.increasedErrors.length, 1);
  const inc = report.increasedErrors[0];
  assert.notEqual(inc.increaseRatio, null, "ratio must be computed from the unrounded baseline");
  assert.ok((inc.increaseRatio ?? 0) > 20);
});

test("increaseFactor controls the sensitivity", () => {
  const entries = [
    ...series("2026-01-07T00:30:00Z", 24, 60, "error", "Flaky"), // 1/hr in last day of baseline → 24/168 ≈ 0.14/hr
    ...series("2026-01-08T00:30:00Z", 6, 240, "error", "Flaky"), // 6/24 = 0.25/hr
  ];
  assert.equal(detectRegression(entries, DEPLOY, { increaseFactor: 2 }).increasedErrors.length, 0);
  assert.equal(detectRegression(entries, DEPLOY, { increaseFactor: 1.5 }).increasedErrors.length, 1);
});
