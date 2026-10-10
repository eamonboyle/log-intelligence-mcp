import { test } from "node:test";
import assert from "node:assert/strict";
import { LogStore } from "../src/engine/store.js";
import { entry, series } from "./helpers.js";
import { SourceConfig } from "../src/types.js";

const src = (name: string): { name: string; type: "flatfile"; config: SourceConfig } => ({
  name,
  type: "flatfile",
  config: { name, type: "flatfile", path: `/tmp/${name}.log` },
});

function populated(): LogStore {
  const store = new LogStore();
  store.add(
    [
      entry("2026-01-01T00:00:00Z", "info", "boot", { source: "app" }),
      entry("2026-01-01T00:05:00Z", "error", "Timeout talking to db", { source: "app", exception: "TimeoutException", fingerprint: "f1" }),
      entry("2026-01-01T00:10:00Z", "warn", "slow", { source: "app" }),
      entry("2026-01-01T00:15:00Z", "fatal", "Out of memory", { source: "app", fingerprint: "f2" }),
    ],
    src("app")
  );
  store.add(
    [
      entry("2026-01-01T00:02:00Z", "error", "GET /x 500", { source: "web", properties: { statusCode: 500, host: "a" } }),
      entry("2026-01-01T00:12:00Z", "error", "GET /y 500", { source: "web", properties: { statusCode: 500, host: "b" } }),
      entry("2026-01-01T00:13:00Z", "info", "GET /z 200", { source: "web", properties: { statusCode: 200, host: "a" } }),
    ],
    src("web")
  );
  return store;
}

test("add keeps entries sorted across sources", () => {
  const store = populated();
  const times = store.all().map((e) => e.timestamp.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(store.size, 7);
});

test("query filters by date range, level(s), source, fingerprint and search", () => {
  const store = populated();
  assert.equal(store.query({ startDate: new Date("2026-01-01T00:05:00Z"), endDate: new Date("2026-01-01T00:12:00Z") }).length, 3);
  assert.equal(store.query({ level: "error" }).length, 3);
  assert.equal(store.errors().length, 4);
  assert.equal(store.query({ source: "WEB" }).length, 3);
  assert.equal(store.query({ fingerprint: "f2" })[0].message, "Out of memory");
  assert.equal(store.query({ search: "timeoutexception" }).length, 1); // matches exception text
  assert.equal(store.query({ search: "^GET /[xy]", regex: true }).length, 2);
  assert.equal(store.query({ limit: 2 }).length, 2);
  assert.throws(() => store.query({ search: "(", regex: true }), /Invalid regular expression/);
});

test("removeSource / clear / hasSource", () => {
  const store = populated();
  assert.equal(store.hasSource("web"), true);
  assert.equal(store.removeSource("web"), 3);
  assert.equal(store.size, 4);
  assert.equal(store.hasSource("web"), false);
  assert.equal(store.removeSource("nope"), 0);
  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(store.getSourceInfo(), []);
});

test("getSourceInfo reports the real adapter type and counts", () => {
  const store = populated();
  const info = store.getSourceInfo().find((s) => s.name === "web")!;
  assert.equal(info.type, "flatfile");
  assert.equal(info.entryCount, 3);
  assert.equal(info.errorCount, 2);
  assert.equal(info.timeRange?.earliest.toISOString(), "2026-01-01T00:02:00.000Z");
  assert.equal(info.timeRange?.latest.toISOString(), "2026-01-01T00:13:00.000Z");
});

test("timeline buckets error entries", () => {
  const store = new LogStore();
  store.add(series("2026-01-01T00:00:00Z", 90, 1, "error", "x"), src("s"));
  const buckets = store.timeline({ bucketMinutes: 30, levels: ["error", "fatal"] });
  assert.deepEqual(buckets.map((b) => b.count), [30, 30, 30]);
});

test("context returns entries around a timestamp", () => {
  const store = populated();
  const { before, after } = store.context({ timestamp: new Date("2026-01-01T00:10:00Z"), before: 2, after: 2 });
  assert.deepEqual(before.map((e) => e.message), ["Timeout talking to db", "slow"]);
  assert.deepEqual(after.map((e) => e.message), ["GET /y 500", "GET /z 200"]);

  const scoped = store.context({ timestamp: new Date("2026-01-01T00:10:00Z"), before: 5, after: 5, source: "web" });
  assert.deepEqual(scoped.before.map((e) => e.message), ["GET /x 500"]);
  assert.deepEqual(scoped.after.map((e) => e.message), ["GET /y 500", "GET /z 200"]);
});

test("groupBy counts property values and pseudo-properties", () => {
  const store = populated();
  const byHost = store.groupBy("host", { levels: ["error", "fatal"] });
  assert.deepEqual(byHost.groups, [
    { value: "a", count: 1 },
    { value: "b", count: 1 },
  ]);
  assert.equal(byHost.missing, 2); // the two app errors have no host
  assert.equal(byHost.total, 4);

  const byLevel = store.groupBy("level");
  assert.equal(byLevel.groups.find((g) => g.value === "error")?.count, 3);
  assert.equal(store.groupBy("source").groups[0].value, "app");
});
