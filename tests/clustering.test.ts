import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMessage, fingerprint, clusterErrors, assignFingerprints } from "../src/engine/clustering.js";
import { entry } from "./helpers.js";

test("normalizeMessage strips variable tokens", () => {
  const n = normalizeMessage(
    'Failed order 4a2c9f11-8e3d-4b7a-9c1e-5f6d7a8b9c0d for user "bob" at 2026-02-10T08:00:00Z from 10.0.0.1:443 via https://api.example.com/x path /var/log/app.log hash deadbeefcafe count 42'
  );
  assert.equal(
    n,
    "failed order <uuid> for user <str> at <timestamp> from <ip> via <url> path <path> hash <n> count <n>"
  );
});

test("messages differing only in variable data share a fingerprint", () => {
  const a = fingerprint("Authentication token expired for user session abc123def456");
  const b = fingerprint("Authentication token expired for user session xyz789ghi012");
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test("email addresses are variable data", () => {
  assert.equal(
    fingerprint("Failed to send notification email to user@example.com"),
    fingerprint("Failed to send notification email to admin@company.co.uk")
  );
  assert.equal(normalizeMessage("mail to a.b+c@x-y.org failed"), "mail to <email> failed");
});

test("different messages get different fingerprints", () => {
  assert.notEqual(fingerprint("Connection refused"), fingerprint("Connection reset"));
});

test("Serilog template holes are treated as variables", () => {
  assert.equal(normalizeMessage("Slow query detected: {QueryTime}ms for {@Query}"), "slow query detected: <var>ms for <var>");
  assert.equal(fingerprint("User {UserId} failed"), fingerprint("User {UserId:N0} failed"));
});

test("words containing digits are treated as variable data", () => {
  assert.equal(normalizeMessage("Timeout after 30ms on db2 (session E1234)"), "timeout after <n> on <n> (session <n>)");
  assert.equal(fingerprint("Timeout after 30ms"), fingerprint("Timeout after 31000ms"));
});

test("fingerprint prefers the template over the rendered message", () => {
  const a = entry("2026-01-01T00:00:00Z", "error", "User alice failed", { template: "User {User} failed" });
  const b = entry("2026-01-01T00:00:00Z", "error", "User bob-the-builder failed", { template: "User {User} failed" });
  assignFingerprints([a, b]);
  assert.equal(a.fingerprint, b.fingerprint);
});

test("first exception line participates in the fingerprint", () => {
  const a = entry("2026-01-01T00:00:00Z", "error", "Request failed", { exception: "TimeoutException: timed out" });
  const b = entry("2026-01-01T00:00:00Z", "error", "Request failed", { exception: "NullReferenceException: boom" });
  assignFingerprints([a, b]);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("clusterErrors groups, counts, samples and sorts", () => {
  const entries = [
    entry("2026-01-01T00:00:00Z", "error", "Timeout after 30ms", { source: "a" }),
    entry("2026-01-01T00:02:00Z", "error", "Timeout after 31ms", { source: "b" }),
    entry("2026-01-01T00:01:00Z", "error", "Timeout after 32ms", { source: "a" }),
    entry("2026-01-01T00:03:00Z", "fatal", "Out of memory"),
    entry("2026-01-01T00:04:00Z", "info", "Timeout after 99ms"), // not an error → ignored
  ];
  const clusters = clusterErrors(entries, 2);
  assert.equal(clusters.length, 2);
  const [top, second] = clusters;
  assert.equal(top.count, 3);
  assert.equal(top.canonicalMessage, "Timeout after 30ms");
  assert.equal(top.firstSeen.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(top.lastSeen.toISOString(), "2026-01-01T00:02:00.000Z");
  assert.equal(top.samples.length, 2);
  assert.deepEqual(top.sources, ["a", "b"]);
  assert.equal(second.count, 1);
});
