import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SerilogAdapter, renderMessageTemplate } from "../src/adapters/serilog.js";
import { FlatfileAdapter, parseApacheDate } from "../src/adapters/flatfile.js";
import { ElasticAdapter, credentialsForEndpoint } from "../src/adapters/elastic.js";
import { SqlAdapter } from "../src/adapters/sql.js";
import { samplePath } from "./helpers.js";

async function withTempFile(name: string, content: string | Uint8Array, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "lim-"));
  try {
    const path = join(dir, name);
    await writeFile(path, content);
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Serilog ──────────────────────────────────────────────────────────────────

test("serilog: parses the sample CLEF file", async () => {
  const result = await new SerilogAdapter().ingest({ name: "app", type: "serilog", path: samplePath("app.clef") });
  assert.ok(result.entries.length > 20);
  assert.equal(result.skipped, 0);
  const first = result.entries[0];
  assert.equal(first.level, "info");
  assert.equal(first.message, "Application started");
  assert.equal(first.source, "app");
  assert.equal(first.properties.Application, "WebAPI");
  const err = result.entries.find((e) => e.level === "error")!;
  assert.match(err.exception ?? "", /TimeoutException/);
});

test("serilog: renders templates and keeps the template for fingerprinting", async () => {
  const clef = [
    '{"@t":"2026-02-10T08:05:00Z","@l":"Warning","@mt":"Slow query detected: {QueryTime}ms for {@Query}","QueryTime":3500,"Query":"SELECT 1"}',
    '{"@t":"2026-02-10T08:06:00Z","@mt":"No level means info"}',
    "not json",
    '{"@t":"2026-02-10T08:07:00Z","Level":"Error","RenderedMessage":"Classic serilog","Properties":{"UserId":7}}',
  ].join("\n");
  await withTempFile("x.clef", clef, async (path) => {
    const result = await new SerilogAdapter().ingest({ name: "t", type: "serilog", path });
    assert.equal(result.entries.length, 3);
    assert.equal(result.skipped, 1);
    assert.equal(result.entries[0].message, "Slow query detected: 3500ms for SELECT 1");
    assert.equal(result.entries[0].template, "Slow query detected: {QueryTime}ms for {@Query}");
    assert.equal(result.entries[0].level, "warn");
    assert.equal(result.entries[1].level, "info");
    assert.equal(result.entries[2].properties.UserId, 7);
    assert.match(result.warnings[0], /1 line/);
  });
});

test("renderMessageTemplate leaves unknown holes intact", () => {
  assert.equal(renderMessageTemplate("Hi {Name}, {Missing}!", { Name: "Bob" }), "Hi Bob, {Missing}!");
  assert.equal(renderMessageTemplate("{Count:N0} items", { Count: 3 }), "3 items");
});

// ── Flatfile ─────────────────────────────────────────────────────────────────

test("flatfile: parses the sample with stack-trace continuation lines", async () => {
  const result = await new FlatfileAdapter().ingest({ name: "web", type: "flatfile", path: samplePath("webserver.log") });
  assert.equal(result.skipped, 0);
  assert.equal(result.entries[0].message, "Server starting on port 8080");
  const pool = result.entries.find((e) => e.message.startsWith("Connection pool exhausted"))!;
  assert.equal(pool.level, "error");
  assert.match(pool.exception ?? "", /java\.sql\.SQLException/);
  assert.match(pool.exception ?? "", /OrderController\.java:45/);
  // No entry should have been given a "now" timestamp
  const now = Date.now();
  assert.ok(result.entries.every((e) => now - e.timestamp.getTime() > 60_000));
});

test("flatfile: apache lines, loose timestamps, custom patterns and leading junk", async () => {
  const text = [
    "garbage header line",
    '127.0.0.1 - - [14/Feb/2026:10:30:00 +0000] "GET /api/orders HTTP/1.1" 500 1234',
    '10.0.0.5 - frank [14/Feb/2026:10:31:00 +0100] "POST /login HTTP/1.1" 401 -',
    "2026-02-14 10:32:00,123 ERROR Something broke",
    "Caused by: java.lang.NullPointerException",
    "\tat com.example.Foo.bar(Foo.java:1)",
  ].join("\n");
  await withTempFile("a.log", text, async (path) => {
    const result = await new FlatfileAdapter().ingest({ name: "a", type: "flatfile", path });
    assert.equal(result.skipped, 1);
    assert.equal(result.entries.length, 3);
    const [apache, login, broke] = result.entries;
    assert.equal(apache.level, "error");
    assert.equal(apache.timestamp.toISOString(), "2026-02-14T10:30:00.000Z");
    assert.deepEqual(apache.properties.statusCode, 500);
    assert.equal(apache.properties.method, "GET");
    assert.equal(login.level, "warn");
    assert.equal(login.timestamp.toISOString(), "2026-02-14T09:31:00.000Z");
    assert.equal(login.properties.bytes, 0);
    assert.equal(broke.timestamp.toISOString(), "2026-02-14T10:32:00.123Z");
    assert.match(broke.exception ?? "", /^Caused by: java\.lang\.NullPointerException\n\tat com/);
  });

  const custom = "level=error ts=2026-03-01T00:00:00Z msg=hello world\nlevel=info ts=2026-03-01T00:00:01Z msg=bye";
  await withTempFile("b.log", custom, async (path) => {
    const result = await new FlatfileAdapter().ingest({
      name: "b",
      type: "flatfile",
      path,
      pattern: "^level=(?<level>\\w+) ts=(?<timestamp>\\S+) msg=(?<message>.*)$",
    });
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].level, "error");
    assert.equal(result.entries[0].message, "hello world");
  });
});

test("parseApacheDate", () => {
  assert.equal(parseApacheDate("14/Feb/2026:10:30:00 +0000").toISOString(), "2026-02-14T10:30:00.000Z");
  assert.equal(parseApacheDate("01/Jan/2026:00:00:00 -0500").toISOString(), "2026-01-01T05:00:00.000Z");
  assert.ok(Number.isNaN(parseApacheDate("nonsense").getTime()));
});

test("flatfile: invalid custom pattern is reported", async () => {
  await assert.rejects(
    new FlatfileAdapter().ingest({ name: "x", type: "flatfile", path: samplePath("webserver.log"), pattern: "(" }),
    /Invalid flatfile pattern/
  );
});

// ── Elastic ──────────────────────────────────────────────────────────────────

test("elastic: parses the sample dump (array of docs)", async () => {
  const result = await new ElasticAdapter().ingest({ name: "es", type: "elastic", path: samplePath("elastic-dump.json") });
  assert.ok(result.entries.length >= 5);
  const err = result.entries.find((e) => e.level === "error")!;
  assert.match(err.exception ?? "", /MapperParsingException/);
  assert.equal(err.properties.index, "api-logs");
});

test("elastic: full response, NDJSON, nested ECS fields and numeric levels", async () => {
  const full = JSON.stringify({
    hits: {
      total: { value: 2 },
      hits: [
        { _source: { "@timestamp": "2026-01-01T00:00:00Z", log: { level: "ERROR" }, message: "ecs nested", error: { stack_trace: "Boom\n at x" } } },
        { _source: { "@timestamp": "2026-01-01T00:01:00Z", level: 50, msg: "pino style" } },
        { _source: { "@timestamp": "2026-01-01T00:02:00Z", log: { level: "warn", logger: "app" }, event: { original: "raw line" } } },
      ],
    },
  });
  await withTempFile("full.json", full, async (path) => {
    const { entries } = await new ElasticAdapter().ingest({ name: "f", type: "elastic", path });
    assert.equal(entries.length, 3);
    assert.equal(entries[0].level, "error");
    assert.equal(entries[0].message, "ecs nested");
    assert.equal(entries[2].message, "raw line", "ECS log object must not be stringified as the message");
    assert.equal(entries[2].level, "warn");
    assert.match(entries[0].exception ?? "", /^Boom/);
    assert.equal(entries[1].level, "error");
    assert.equal(entries[1].message, "pino style");
  });

  const ndjson = [
    '{"_source":{"@timestamp":"2026-01-01T00:00:00Z","level":"warn","message":"a"}}',
    '{"timestamp":"2026-01-01T00:00:01Z","severity":"info","message":"b"}',
    '{"no":"timestamp"}',
    "{broken",
  ].join("\n");
  await withTempFile("x.ndjson", ndjson, async (path) => {
    const result = await new ElasticAdapter().ingest({ name: "n", type: "elastic", path });
    assert.equal(result.entries.length, 2);
    assert.equal(result.skipped, 2);
  });
});

test("elastic: requires a path when no endpoint is given", async () => {
  await assert.rejects(new ElasticAdapter().ingest({ name: "x", type: "elastic" }), /requires a "path"/);
});

/** Run `fn` with ELASTIC_* env vars set and fetch stubbed; returns the Authorization header of each request. */
async function captureElasticAuth(env: Record<string, string>, fn: () => Promise<unknown>): Promise<Array<string | undefined>> {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  const seen: Array<string | undefined> = [];
  Object.assign(process.env, env);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ hits: { hits: [], total: { value: 0 } } }), { status: 200 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(env)) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
  return seen;
}

test("elastic: environment credentials are only sent when allowed", async () => {
  const adapter = new ElasticAdapter();
  const endpoint = "https://es.example:9200";
  const seen = await captureElasticAuth({ ELASTIC_API_KEY: "env-key" }, async () => {
    await adapter.ingest({ name: "a", type: "elastic", endpoint });
    await adapter.ingest({ name: "b", type: "elastic", endpoint, allowEnvCredentials: true });
    await adapter.ingest({ name: "c", type: "elastic", endpoint, apiKey: "explicit" });
  });
  assert.deepEqual(seen, [undefined, "ApiKey env-key", "ApiKey explicit"]);

  const basic = await captureElasticAuth({ ELASTIC_USERNAME: "u", ELASTIC_PASSWORD: "p" }, () =>
    adapter.ingest({ name: "d", type: "elastic", endpoint, allowEnvCredentials: true })
  );
  assert.deepEqual(basic, [`Basic ${Buffer.from("u:p").toString("base64")}`]);
});

test("elastic: warns when credentials go over plain HTTP to a remote host", async () => {
  const adapter = new ElasticAdapter();
  let remote: string[] = [];
  let local: string[] = [];
  await captureElasticAuth({}, async () => {
    remote = (await adapter.ingest({ name: "r", type: "elastic", endpoint: "http://es.internal:9200", apiKey: "k" })).warnings;
    local = (await adapter.ingest({ name: "l", type: "elastic", endpoint: "http://localhost:9200", apiKey: "k" })).warnings;
  });
  assert.ok(remote.some((w) => /unencrypted HTTP/.test(w)));
  assert.ok(!local.some((w) => /unencrypted HTTP/.test(w)));
});

test("elastic: credentialsForEndpoint trusts only configured endpoints", () => {
  const sources = [{ name: "prod", type: "elastic" as const, endpoint: "https://ES.internal:9200/", apiKey: "prod-key" }];
  assert.deepEqual(credentialsForEndpoint("https://es.internal:9200", sources, {}), { apiKey: "prod-key", allowEnvCredentials: true });
  assert.deepEqual(credentialsForEndpoint("https://evil.example:9200", sources, {}), {});
  assert.deepEqual(credentialsForEndpoint("https://es.internal:9201", sources, {}), {});
  assert.deepEqual(credentialsForEndpoint("not a url", sources, {}), {});

  const env = { ELASTIC_URL: "http://localhost:9200" };
  assert.deepEqual(credentialsForEndpoint("http://localhost:9200/", [], env), { allowEnvCredentials: true });
  assert.deepEqual(credentialsForEndpoint("http://localhost:9300", [], env), {});
});

// ── SQL ──────────────────────────────────────────────────────────────────────

test("sql: reads a SQLite file with conventional columns and a filter", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE Logs (Id INTEGER PRIMARY KEY, Timestamp TEXT, Level TEXT, Message TEXT, Exception TEXT, Host TEXT)");
  db.run("INSERT INTO Logs (Timestamp, Level, Message, Exception, Host) VALUES (?, ?, ?, ?, ?)", [
    "2026-01-01T00:00:00Z", "Information", "started", null, "h1",
  ]);
  db.run("INSERT INTO Logs (Timestamp, Level, Message, Exception, Host) VALUES (?, ?, ?, ?, ?)", [
    "2026-01-01T00:01:00Z", "Error", "db down", "SqlException: timeout", "h1",
  ]);
  db.run("INSERT INTO Logs (Timestamp, Level, Message, Exception, Host) VALUES (?, ?, ?, ?, ?)", [
    "not a date", "Error", "bad row", null, "h2",
  ]);
  const bytes = db.export();
  db.close();

  await withTempFile("logs.db", bytes, async (path) => {
    const all = await new SqlAdapter().ingest({ name: "db", type: "sql", path });
    assert.equal(all.entries.length, 2);
    assert.equal(all.skipped, 1);
    assert.equal(all.entries[1].level, "error");
    assert.equal(all.entries[1].exception, "SqlException: timeout");
    assert.equal(all.entries[1].properties.Host, "h1");
    assert.equal(all.entries[1].properties.Id, 2);

    const filtered = await new SqlAdapter().ingest({ name: "db", type: "sql", path, filter: "Level = 'Error'" });
    assert.equal(filtered.entries.length, 1);

    await assert.rejects(new SqlAdapter().ingest({ name: "db", type: "sql", path, table: "Missing" }), /no such table/);
  });
});
