import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContext, createServer } from "../src/server.js";
import { samplePath } from "./helpers.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

let client: Client;
let close: () => Promise<void>;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function text(result: ToolResult): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

before(async () => {
  const ctx = createContext();
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});

after(async () => {
  await close();
});

test("advertises the expected tools, resources and prompts", async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "clear_logs",
    "detect_new_error_pattern",
    "get_error_timeline",
    "get_log_context",
    "group_by_property",
    "ingest_logs",
    "list_sources",
    "regression_after_date",
    "search_logs",
    "summarise_errors",
  ]);
  const ingest = (await client.listTools()).tools.find((t) => t.name === "ingest_logs")!;
  assert.ok(ingest.outputSchema, "tools expose an outputSchema");
  assert.equal(ingest.annotations?.openWorldHint, true);

  const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
  assert.deepEqual(resources, ["logs://sources", "logs://summary"]);
  const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  assert.deepEqual(templates, ["logs://cluster/{fingerprint}"]);

  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ["analyse-logs", "investigate-error", "review-deployment"]);
});

test("empty store responses", async () => {
  const list = await call("list_sources");
  assert.match(text(list), /No logs ingested yet/);
  assert.deepEqual(list.structuredContent, { sources: [], totalEntries: 0 });

  const reg = await call("regression_after_date", { deploymentDate: "2026-02-10T12:00:00Z" });
  assert.equal(reg.isError, true);
  assert.match(text(reg), /Ingest logs first/);
});

test("ingest_logs loads all three sample sources and replaces on re-ingest", async () => {
  const a = await call("ingest_logs", { source: "serilog", path: samplePath("app.clef"), name: "app" });
  assert.equal(a.isError, undefined);
  const sa = a.structuredContent as { ingested: number; errors: number; replaced: number; totalInStore: number };
  assert.ok(sa.ingested > 0);
  assert.ok(sa.errors > 0);
  assert.equal(sa.replaced, 0);

  const again = await call("ingest_logs", { source: "serilog", path: samplePath("app.clef"), name: "app" });
  const sb = again.structuredContent as { replaced: number; totalInStore: number };
  assert.equal(sb.replaced, sa.ingested);
  assert.equal(sb.totalInStore, sa.totalInStore, "replace mode must not double-count");

  const appended = await call("ingest_logs", { source: "serilog", path: samplePath("app.clef"), name: "app", mode: "append" });
  assert.equal((appended.structuredContent as { totalInStore: number }).totalInStore, sa.totalInStore * 2);
  // reset to a single copy
  await call("ingest_logs", { source: "serilog", path: samplePath("app.clef"), name: "app" });

  await call("ingest_logs", { source: "flatfile", path: samplePath("webserver.log"), name: "web" });
  await call("ingest_logs", { source: "elastic", path: samplePath("elastic-dump.json"), name: "es" });

  const list = await call("list_sources");
  const sources = (list.structuredContent as { sources: Array<{ name: string; type: string }> }).sources;
  assert.deepEqual(sources.map((s) => `${s.name}:${s.type}`).sort(), ["app:serilog", "es:elastic", "web:flatfile"]);
});

test("ingest_logs reports bad input as a tool error, not a crash", async () => {
  const r = await call("ingest_logs", { source: "serilog", path: "/definitely/not/here.clef" });
  assert.equal(r.isError, true);
  assert.match(text(r), /ENOENT|no such file/i);

  const noPath = await call("ingest_logs", { source: "elastic" });
  assert.equal(noPath.isError, true);
  assert.match(text(noPath), /needs a path/);
});

test("summarise_errors returns text and structured clusters", async () => {
  const r = await call("summarise_errors", { topN: 3 });
  assert.match(text(r), /Error Summary/);
  const s = r.structuredContent as { totalErrors: number; uniquePatterns: number; clusters: Array<{ count: number; fingerprint: string }> };
  assert.ok(s.totalErrors > 0);
  assert.equal(s.clusters.length, 3);
  assert.ok(s.clusters[0].count >= s.clusters[1].count, "sorted by count");

  const scoped = await call("summarise_errors", { source: "web", minCount: 2 });
  const ss = scoped.structuredContent as { clusters: Array<{ sources: string[]; count: number }> };
  assert.ok(ss.clusters.every((c) => c.sources.every((src) => src === "web")));
  assert.ok(ss.clusters.every((c) => c.count >= 2));
});

test("invalid dates are reported as input errors", async () => {
  const r = await call("summarise_errors", { startDate: "yesterday-ish" });
  assert.equal(r.isError, true);
  assert.match(text(r), /Invalid date for "startDate"/);
});

test("get_error_timeline with anomaly detection on the sample data", async () => {
  const r = await call("get_error_timeline", { bucketMinutes: 60, detectAnomalies: true, source: "app" });
  assert.match(text(r), /Error timeline/);
  const s = r.structuredContent as { buckets: unknown[]; anomalies?: { buckets: unknown[]; threshold: number } };
  assert.ok(s.buckets.length > 1);
  assert.ok(s.anomalies, "anomalies block present when requested");
  assert.equal(s.anomalies!.threshold, 2);
});

test("regression_after_date finds the simulated post-deploy Redis outage", async () => {
  // The sample CLEF file simulates a v2.4.1 deployment finishing at 09:05 followed by a Redis outage
  const r = await call("regression_after_date", { deploymentDate: "2026-02-10T09:05:00Z", hoursBefore: 2, hoursAfter: 2, source: "app" });
  assert.equal(r.isError, undefined, text(r));
  const s = r.structuredContent as { newErrors: Array<{ message: string }>; summary: string };
  assert.ok(s.newErrors.some((c) => /redis/i.test(c.message)), `expected a Redis regression, got: ${s.newErrors.map((c) => c.message).join(" | ")}`);
});

test("search_logs, get_log_context and group_by_property", async () => {
  const search = await call("search_logs", { query: "redis", limit: 2 });
  const ss = search.structuredContent as { total: number; returned: number; entries: Array<{ timestamp: string; fingerprint: string }> };
  assert.ok(ss.total >= 2);
  assert.equal(ss.returned, 2);

  const regex = await call("search_logs", { query: "^Database connection timeout", regex: true });
  assert.ok((regex.structuredContent as { total: number }).total > 0);
  const badRegex = await call("search_logs", { query: "(", regex: true });
  assert.equal(badRegex.isError, true);

  const ctx = await call("get_log_context", { timestamp: ss.entries[0].timestamp, before: 3, after: 3, source: "app" });
  const sc = ctx.structuredContent as { before: unknown[]; after: unknown[] };
  assert.ok(sc.before.length > 0);
  assert.ok(sc.after.length > 0);

  const byFp = await call("search_logs", { query: ".", regex: true, fingerprint: ss.entries[0].fingerprint, limit: 1000 });
  const sf = byFp.structuredContent as { entries: Array<{ fingerprint: string }> };
  assert.ok(sf.entries.length > 0 && sf.entries.every((e) => e.fingerprint === ss.entries[0].fingerprint));

  const grouped = await call("group_by_property", { property: "level", errorsOnly: false });
  const sg = grouped.structuredContent as { groups: Array<{ value: string; count: number }>; total: number };
  assert.ok(sg.groups.some((g) => g.value === "info"));
  assert.equal(sg.groups.reduce((n, g) => n + g.count, 0), sg.total);

  const bySource = await call("group_by_property", { property: "source" });
  assert.deepEqual((bySource.structuredContent as { groups: Array<{ value: string }> }).groups.map((g) => g.value).sort(), ["app", "es", "web"]);
});

test("resources reflect the store", async () => {
  const readJson = async <T,>(uri: string): Promise<T> => {
    const res = await client.readResource({ uri });
    return JSON.parse((res.contents[0] as { text: string }).text) as T;
  };
  const parsed = await readJson<{ sources: Array<{ name: string }> }>("logs://sources");
  assert.equal(parsed.sources.length, 3);

  const summary = await readJson<{ uniqueErrorPatterns: number }>("logs://summary");
  assert.ok(summary.uniqueErrorPatterns > 0);

  const top = await call("summarise_errors", { topN: 1 });
  const fp = (top.structuredContent as { clusters: Array<{ fingerprint: string }> }).clusters[0].fingerprint;
  const cluster = await readJson<{ fingerprint: string; count: number }>(`logs://cluster/${fp}`);
  assert.equal(cluster.fingerprint, fp);
  assert.ok(cluster.count > 0);

  const completion = await client.complete({ ref: { type: "ref/resource", uri: "logs://cluster/{fingerprint}" }, argument: { name: "fingerprint", value: fp.slice(0, 3) } });
  assert.ok(completion.completion.values.includes(fp));
});

test("prompts render with arguments", async () => {
  const p = await client.getPrompt({ name: "review-deployment", arguments: { deploymentDate: "2026-02-10T12:00:00Z", hoursAfter: "6" } });
  const body = p.messages[0].content as { type: string; text: string };
  assert.match(body.text, /regression_after_date/);
  assert.match(body.text, /hoursAfter=6/);
});

test("clear_logs removes one source then everything", async () => {
  const one = await call("clear_logs", { source: "web" });
  const so = one.structuredContent as { removed: number; remaining: number };
  assert.ok(so.removed > 0);

  const unknown = await call("clear_logs", { source: "web" });
  assert.match(text(unknown), /No source named "web"/);

  const all = await call("clear_logs");
  assert.equal((all.structuredContent as { remaining: number }).remaining, 0);
  assert.match(text(await call("list_sources")), /No logs ingested yet/);
});
