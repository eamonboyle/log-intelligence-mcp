# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security
- Updated `@modelcontextprotocol/sdk` 1.26 → 1.32, clearing an OAuth credential-leak advisory in the SDK and 10 further advisories in its transitive dependencies (hono, express stack, path-to-regexp, qs, fast-uri, ip-address). `npm audit` is now clean.

### Changed
- **Breaking:** requires Node.js 22 or newer (Node 18 and 20 are end-of-life).
- Dependencies updated to current majors: zod 4, TypeScript 7, tsx 4.23, sql.js 1.14.2, `@types/node` 22. Hand-written sql.js typings replaced by `@types/sql.js`.
- Migrated to the SDK's `registerTool` / `registerResource` / `registerPrompt` APIs. Every tool now has a title, behaviour annotations and an `outputSchema`, and returns `structuredContent` alongside the human-readable text.
- Server version is read from `package.json` instead of being hard-coded.
- Error fingerprinting treats any word containing a digit (`30ms`, `db2`, `abc123def456`) as variable data, so messages that differ only in such tokens cluster together. Serilog events are fingerprinted on their message template when one is present.
- Re-ingesting a source with the same name replaces its previous entries instead of duplicating them (`mode: "append"` restores the old behaviour).
- Relative source paths in the config file are resolved against the config file's directory rather than the process working directory.
- Invalid or malformed config files produce a warning on stderr instead of being silently ignored; a config path given via `--config` or `LOG_INTELLIGENCE_CONFIG` that cannot be read is a startup error.
- Invalid ISO dates passed to tools now return a clear tool error instead of silently matching nothing.
- Serilog and flat-file adapters stream files line by line instead of loading them fully into memory.
- Flat-file lines that cannot be attributed to an entry are counted as skipped instead of being stamped with the current time; non-indented continuation lines such as `Caused by:` are attached to the preceding entry.
- Apache/Nginx timestamps are parsed explicitly (previously relied on non-standard `Date` parsing) and method, path, protocol and bytes are extracted as properties.
- Numeric pino/bunyan levels (10–60) and more aliases (`crit`, `emerg`, `notice`, …) are recognised across all adapters. Small integers (0–7) are deliberately left as `info` because syslog and .NET/App Insights scales run in opposite directions.
- Timeline and anomaly requests are capped at 10 000 buckets and return a clear error above that, instead of exhausting memory on tiny bucket sizes over long ranges.
- Regression rate comparisons use exact rates; previously a baseline below 0.005/hour rounded to zero and was misreported as a new error.
- `logs://sources` reports the real adapter type for each source (previously always `serilog`).
- Internal: level normalisation, bucketing and cluster formatting were deduplicated; the monolithic server file was split into per-tool modules; the store uses binary search for time ranges and a merge for inserts.

### Added
- `list_sources` tool (resources are not supported by every MCP client).
- `clear_logs` tool to drop one source or everything without restarting.
- `get_log_context` tool: entries before and after a timestamp, optionally filtered by source and minimum level.
- `group_by_property` tool: count entries by a structured property (or `level`, `source`, `fingerprint`).
- `search_logs`: `regex`, `source` and `fingerprint` filters; result count before truncation.
- `regression_after_date`: `increaseFactor` and `source` arguments.
- `get_error_timeline`: `source` and `anomalyThreshold` arguments.
- `logs://cluster/{fingerprint}` resource template with fingerprint completion.
- `review-deployment` prompt.
- Live Elasticsearch: API key (`apiKey` / `ELASTIC_API_KEY`) or basic auth (`ELASTIC_USERNAME` / `ELASTIC_PASSWORD`), sent only to endpoints from the config file or `ELASTIC_URL`; configurable `limit` and `timestampField`, warning when results were truncated.
- Ingest results report skipped lines and adapter warnings.
- CLI flags `--config`, `--version`, `--help`; `LOG_INTELLIGENCE_CONFIG` environment variable.
- Server `instructions` so clients know which tool to reach for first.
- Test suite (58 tests, `node:test`) covering the engine, every adapter, config loading and an end-to-end in-memory MCP client. GitHub Actions workflow running typecheck, tests, build and `npm audit` on Node 22 and 24.

## [1.0.0] - 2026-02

Initial release.
