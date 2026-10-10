# Log Intelligence MCP Server

[![Add to Cursor](https://img.shields.io/badge/Add_to-Cursor-000000?style=for-the-badge&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=log-intelligence&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImxvZy1pbnRlbGxpZ2VuY2UtbWNwIl19)
[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://intradeus.github.io/http-protocol-redirector?r=vscode%3A%2F%2Fmcp%2Finstall%3F%257B%2522name%2522%253A%2522log-intelligence%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522log-intelligence-mcp%2522%255D%257D)

An AI-powered log analysis server built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It ingests structured logs from multiple sources, detects anomalies, clusters similar errors, summarises recurring failures, and identifies regressions after deployments.

## Features

- **Multi-source ingestion** -- Serilog JSON/CLEF, Elasticsearch dumps or live endpoints, SQLite databases, plain text log files
- **Error fingerprinting** -- Normalises variable data (ids, numbers, paths, emails, …) and clusters similar error messages
- **Anomaly detection** -- Statistical spike detection using z-score analysis on time-bucketed error rates
- **Regression detection** -- Compares error patterns before/after a deployment date
- **Context and search** -- Substring or regex search, and the entries surrounding any point in time
- **Property breakdowns** -- Count errors by any structured property (application, host, status code, …)
- **Timeline visualisation** -- Error frequency bucketed over time with ASCII bar charts
- **Structured output** -- Every tool returns both readable text and JSON `structuredContent` with a published schema

Requires Node.js 22 or newer.

## Install

```bash
# From npm (recommended)
npm install -g log-intelligence-mcp

# Or run without installing
npx log-intelligence-mcp
```

## Quick Start (from source)

```bash
npm install
npm run build
npm start          # stdio transport for MCP clients
```

```
log-intelligence-mcp [options]

  -c, --config <path>  Config file (default: ./log-intelligence.config.json, or $LOG_INTELLIGENCE_CONFIG)
  -v, --version        Print the version and exit
  -h, --help           Show help
```

## MCP Client Configuration

### Cursor (recommended: npx)

Add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "log-intelligence": {
      "command": "npx",
      "args": ["-y", "log-intelligence-mcp"]
    }
  }
}
```

### Cursor (global install)

```json
{
  "mcpServers": {
    "log-intelligence": {
      "command": "log-intelligence-mcp",
      "args": ["--config", "/path/to/log-intelligence.config.json"]
    }
  }
}
```

### Cursor (local development)

```json
{
  "mcpServers": {
    "log-intelligence": {
      "command": "node",
      "args": ["path/to/log-intelligence-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop / Claude Code

Add to `claude_desktop_config.json`, or run `claude mcp add log-intelligence -- npx -y log-intelligence-mcp`:

```json
{
  "mcpServers": {
    "log-intelligence": {
      "command": "npx",
      "args": ["-y", "log-intelligence-mcp"],
      "env": { "LOG_INTELLIGENCE_CONFIG": "/path/to/log-intelligence.config.json" }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `ingest_logs` | Load logs from a source (serilog, elastic, sql, flatfile). Re-ingesting a source name replaces it unless `mode: "append"` |
| `list_sources` | Ingested sources with entry/error counts and time ranges |
| `clear_logs` | Remove one source, or everything |
| `summarise_errors` | Cluster and summarise error-level entries |
| `detect_new_error_pattern` | Find errors in a comparison window absent from a baseline window |
| `regression_after_date` | Compare error patterns before/after a deployment |
| `search_logs` | Substring or regex search across messages and exceptions, filterable by level, source, fingerprint and time |
| `get_log_context` | Entries immediately before and after a timestamp, across all levels |
| `group_by_property` | Count entries by a structured property (or `level`, `source`, `fingerprint`) |
| `get_error_timeline` | Error frequency over time with optional anomaly detection |

All tools accept ISO 8601 dates and return `structuredContent` matching their advertised `outputSchema`, so clients can work with the data directly rather than parsing text.

## Resources

| URI | Description |
|-----|-------------|
| `logs://sources` | List all ingested log sources with entry counts |
| `logs://summary` | Overall stats: total entries, error count, unique patterns |
| `logs://cluster/{fingerprint}` | Details and sample entries for one error cluster (fingerprints autocomplete) |

## Prompts

| Prompt | Description |
|--------|-------------|
| `analyse-logs` | Guided workflow: ingest, summarise, detect anomalies, inspect context |
| `investigate-error` | Deep dive into a specific error pattern |
| `review-deployment` | Go/no-go review of a deployment using regression detection |

## Log Sources

### Serilog JSON (.clef)

Reads [Compact Log Event Format](https://clef-lang.org/) files -- one JSON object per line with `@t`, `@l`, `@mt`, `@m`, `@x` fields -- and classic Serilog JSON (`Timestamp`, `Level`, `RenderedMessage`, `Properties`). When only a message template is present it is rendered from the event properties for display, and the template itself is used for clustering. Files are streamed, so large logs are fine.

```
ingest_logs(source="serilog", path="./logs/app.clef")
```

### Elasticsearch

Accepts a JSON array of `_source` documents, a full ES response (`hits.hits[]._source`), or NDJSON. Field names follow common conventions including ECS (`@timestamp`, `log.level`, `message`, `error.stack_trace`); nested objects and dotted keys both work, and numeric levels (pino, syslog) are understood.

```
# File dump
ingest_logs(source="elastic", path="./dumps/errors.json")

# Live query
ingest_logs(source="elastic", endpoint="http://localhost:9200", index="app-logs", filter="level:error", limit=5000)
```

Live queries authenticate with `apiKey` in the config file or the `ELASTIC_API_KEY` environment variable, or with `ELASTIC_USERNAME` and `ELASTIC_PASSWORD`. Results are sorted by `timestampField` (default `@timestamp`) and capped at 10 000 documents; a warning is returned when more matched.

### SQLite Debug Tables

Reads from SQLite database files. Columns are mapped by convention (`Timestamp`/`created_at`, `Level`/`severity`, `Message`/`msg`, `Exception`/`error`); other columns become properties.

```
ingest_logs(source="sql", path="./debug.db", table="Logs", filter="Level = 'Error'")
```

### Flat Files

Parses `2026-02-10T07:10:00Z [ERROR] message` and `2026-02-10 07:10:00,123 ERROR message` styles plus Apache/Nginx combined access logs (status ≥ 500 becomes an error, ≥ 400 a warning). Lines that do not start a new entry -- stack frames, `Caused by:` lines, wrapped text -- are attached to the previous entry as its exception. Files are streamed.

```
ingest_logs(source="flatfile", path="./logs/app.log")

# Custom format via regex with named groups
ingest_logs(source="flatfile", path="./app.log", pattern="^level=(?<level>\\w+) ts=(?<timestamp>\\S+) msg=(?<message>.*)$")
```

## Configuration

Optionally create a `log-intelligence.config.json` to pre-configure sources. It is looked for in the working directory, or at the path given by `--config` / `LOG_INTELLIGENCE_CONFIG`. Relative paths are resolved against the config file's own directory, so it works regardless of where the MCP client launches the server from.

```json
{
  "sources": [
    { "name": "app-logs", "type": "serilog", "path": "./logs/app.clef" },
    { "name": "db-errors", "type": "sql", "path": "./debug.db", "table": "Logs", "filter": "Level = 'Error'" },
    { "name": "prod-es", "type": "elastic", "endpoint": "https://es.internal:9200", "index": "app-*", "filter": "log.level:error", "limit": 5000 }
  ],
  "defaults": {
    "bucketMinutes": 60,
    "anomalyThreshold": 2.0,
    "maxSamples": 3
  }
}
```

Pre-configured sources are ingested when the server starts. Problems with the file are reported on stderr instead of being silently ignored.

## How It Works

### Error Fingerprinting

Messages are normalised by replacing variable tokens -- timestamps, URLs, email addresses, IPs, UUIDs, file paths, quoted strings, and any word containing a digit (`30ms`, `db2`, `abc123def456`) -- then collapsed and SHA-256 hashed to a 16-character fingerprint. The first line of the exception, if any, is included. Entries sharing a fingerprint form an error cluster.

### Anomaly Detection

Error entries are bucketed into time windows. The baseline mean and standard deviation are computed, and buckets where `count > mean + threshold * stddev` are flagged as anomalous. Each bucket gets a z-score for ranking.

### Regression Detection

Given a deployment date, the detector splits logs into before/after windows, clusters errors independently in each, then performs a set-diff to identify:
- **New errors** -- appeared only after deployment
- **Increased errors** -- existed before but the hourly rate grew by more than `increaseFactor` (default 2×)
- **Resolved errors** -- disappeared after deployment

## Sample Data

The `samples/` directory contains example log files for testing:
- `app.clef` -- Serilog CLEF format with a simulated deployment at 09:05 followed by a Redis outage
- `webserver.log` -- Flat file format with Java stack traces
- `elastic-dump.json` -- Elasticsearch JSON dump
- `log-intelligence.config.json` -- Config to auto-ingest all samples

The repository root already contains a config pointing at the samples, so `npm start` from a source checkout serves them immediately. Try `regression_after_date` with `deploymentDate="2026-02-10T09:05:00Z"`, `hoursBefore=2`, `hoursAfter=2`.

## Development

```bash
npm run dev         # run from source with tsx
npm run typecheck   # tsc --noEmit over src and tests
npm test            # node:test suite (engine, adapters, config, end-to-end MCP client)
npm run build       # emit dist/
```

The end-to-end tests drive the server through the SDK's in-memory transport with a real MCP client, so tool schemas, structured output and resource templates are exercised exactly as a client would see them.

## License

MIT
