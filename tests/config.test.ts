import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, parseConfig } from "../src/config.js";

async function inTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "lim-cfg-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseConfig fills defaults and resolves relative paths against the config dir", () => {
  const cfg = parseConfig(
    { sources: [{ name: "a", type: "serilog", path: "./logs/app.clef" }, { name: "b", type: "elastic", endpoint: "http://es:9200" }], defaults: { maxSamples: 5 } },
    "/etc/lim"
  );
  assert.equal(cfg.sources[0].path, resolve("/etc/lim", "./logs/app.clef"));
  assert.equal(cfg.sources[1].path, undefined);
  assert.deepEqual(cfg.defaults, { bucketMinutes: 60, anomalyThreshold: 2, maxSamples: 5 });
});

test("parseConfig rejects bad sources", () => {
  assert.throws(() => parseConfig({ sources: [{ name: "a", type: "serilog" }] }, "/"), /path or an endpoint/);
  assert.throws(() => parseConfig({ sources: [{ name: "a", type: "nope", path: "x" }] }, "/"));
});

test("loadConfig: missing default file is fine, explicit missing file throws", async () => {
  await inTempDir(async (dir) => {
    const loaded = await loadConfig(join(dir, "nope.json")).catch((e) => e);
    assert.ok(loaded instanceof Error);
    assert.match(loaded.message, /Cannot read config file/);
  });
});

test("loadConfig: invalid JSON and invalid schema produce warnings and defaults", async () => {
  await inTempDir(async (dir) => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    const a = await loadConfig(bad);
    assert.equal(a.config.sources.length, 0);
    assert.equal(a.warnings.length, 1);
    assert.match(a.warnings[0], /not valid JSON/);

    const wrong = join(dir, "wrong.json");
    await writeFile(wrong, JSON.stringify({ sources: [{ name: "", type: "serilog", path: "x" }] }));
    const b = await loadConfig(wrong);
    assert.equal(b.config.sources.length, 0);
    assert.match(b.warnings[0], /invalid/);
    assert.match(b.warnings[0], /sources\.0\.name/);
  });
});

test("loadConfig: valid file is loaded and paths resolved", async () => {
  await inTempDir(async (dir) => {
    const good = join(dir, "good.json");
    await writeFile(good, JSON.stringify({ sources: [{ name: "a", type: "flatfile", path: "app.log" }] }));
    const loaded = await loadConfig(good);
    assert.equal(loaded.path, good);
    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.config.sources[0].path, join(dir, "app.log"));
  });
});
