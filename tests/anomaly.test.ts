import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, stats } from "../src/engine/anomaly.js";
import { bucketize } from "../src/util/time.js";
import { entry, series } from "./helpers.js";

test("stats computes population mean and stddev", () => {
  const { mean, stddev } = stats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.equal(stddev, 2);
  assert.deepEqual(stats([]), { mean: 0, stddev: 0 });
});

test("bucketize aligns to bucket boundaries and includes empty buckets", () => {
  const items = [
    entry("2026-01-01T00:10:00Z", "error", "x"),
    entry("2026-01-01T02:50:00Z", "error", "x"),
    entry("2026-01-01T00:40:00Z", "error", "x"),
  ];
  const buckets = bucketize(items, 60 * 60 * 1000);
  assert.equal(buckets.length, 3);
  assert.equal(new Date(buckets[0].start).toISOString(), "2026-01-01T00:00:00.000Z");
  assert.deepEqual(buckets.map((b) => b.count), [2, 0, 1]);
  assert.deepEqual(bucketize([], 1000), []);
});

test("bucketize refuses to create an unbounded number of buckets", () => {
  const items = [entry("2026-01-01T00:00:00Z", "error", "x"), entry("2026-04-01T00:00:00Z", "error", "x")];
  assert.throws(() => bucketize(items, 60_000), /buckets \(max 10,000\)/);
  assert.equal(bucketize(items, 60_000, 200_000).length, 129_601);
});

test("detectAnomalies flags a spike against a flat baseline", () => {
  // 1 error per hour for 23 hours, then 30 errors in one hour
  const baseline = series("2026-01-01T00:30:00Z", 23, 60, "error", "steady");
  const spike = series("2026-01-01T23:00:00Z", 30, 1, "error", "spike");
  const result = detectAnomalies([...baseline, ...spike], 60, 2.0);

  assert.equal(result.totalBuckets, 24);
  assert.equal(result.anomalousBuckets.length, 1);
  assert.equal(result.anomalousBuckets[0].count, 30);
  assert.equal(result.anomalousBuckets[0].start.toISOString(), "2026-01-01T23:00:00.000Z");
  assert.ok(result.anomalousBuckets[0].zScore > 2);
});

test("detectAnomalies reports nothing for a uniform series", () => {
  const result = detectAnomalies(series("2026-01-01T00:30:00Z", 10, 60, "error", "steady"), 60, 2.0);
  assert.equal(result.anomalousBuckets.length, 0);
  assert.equal(result.baselineStddev, 0);
});

test("detectAnomalies can be scoped to a fingerprint", () => {
  const a = series("2026-01-01T00:30:00Z", 5, 60, "error", "a").map((e) => ({ ...e, fingerprint: "aaaa" }));
  const b = series("2026-01-01T02:00:00Z", 50, 1, "error", "b").map((e) => ({ ...e, fingerprint: "bbbb" }));
  const result = detectAnomalies([...a, ...b], 60, 2.0, "aaaa");
  assert.equal(result.fingerprint, "aaaa");
  assert.equal(result.anomalousBuckets.length, 0);
});
