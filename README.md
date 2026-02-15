# Log Intelligence MCP Server

[![Add to Cursor](https://img.shields.io/badge/Add_to-Cursor-000000?style=for-the-badge&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=log-intelligence&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImxvZy1pbnRlbGxpZ2VuY2UtbWNwIl19)
[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](vscode://mcp/install?%7B%22name%22%3A%22log-intelligence%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22log-intelligence-mcp%22%5D%7D)

An AI-powered log analysis server built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It ingests structured logs from multiple sources, detects anomalies, clusters similar errors, summarises recurring failures, and identifies regressions after deployments.

## Features

- **Multi-source ingestion** -- Serilog JSON/CLEF, Elasticsearch dumps, SQLite databases, plain text log files
- **Error fingerprinting** -- Automatically normalises and clusters similar error messages
- **Anomaly detection** -- Statistical spike detection using z-score analysis on time-bucketed error rates
- **Regression detection** -- Compares error patterns before/after a deployment date
- **Full-text search** -- Search across all ingested log entries
- **Timeline visualisation** -- Error frequency bucketed over time with ASCII bar charts

## Install

```bash
# From npm (recommended)
npm install -g log-intelligence-mcp

# Or run without installing
npx log-intelligence-mcp
```

## Quick Start (from source)

```bash
# Install dependencies
npm install

# Build
npm run build

# Run (stdio transport for MCP clients)
npm start
```

## MCP Client Configuration

### Cursor (recommended: npx)

Add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "log-intelligence": {
      "command": "npx",
      "args": ["log-intelligence-mcp"]
    }
  }
}
```

### Cursor (global install)

If you installed globally with `npm install -g log-intelligence-mcp`:

```json
{
  "mcpServers": {
    "log-intelligence": {
      "command": "log-intelligence-mcp"
    }
  }
}
```

### Cursor (local development)

When developing from source:

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

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "log-intelligence": {
      "command": "npx",
      "args": ["log-intelligence-mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `ingest_logs` | Load logs from a source (serilog, elastic, sql, flatfile) |
| `summarise_errors` | Cluster and summarise error-level entries |
| `detect_new_error_pattern` | Find errors in a comparison window absent from a baseline |
| `regression_after_date` | Compare error patterns before/after a deployment |
| `search_logs` | Full-text search across all ingested entries |
| `get_error_timeline` | Error frequency over time with optional anomaly detection |

## Resources

| URI | Description |
|-----|-------------|
| `logs://sources` | List all ingested log sources with entry counts |
| `logs://summary` | Overall stats: total entries, error count, unique patterns |

## Prompts

| Prompt | Description |
|--------|-------------|
| `analyse-logs` | Guided workflow: ingest, summarise, detect anomalies |
| `investigate-error` | Deep dive into a specific error pattern |

## Log Sources

### Serilog JSON (.clef)

Reads [Compact Log Event Format](https://clef-lang.org/) files -- one JSON object per line with `@t`, `@l`, `@mt`, `@m`, `@x` fields. Also supports standard Serilog JSON output.

```bash
# Example: ingest a Serilog file
ingest_logs(source="serilog", path="./logs/app.clef")
```

### Elasticsearch Dumps

Accepts JSON array of `_source` documents, full ES response format (`hits.hits[]._source`), or NDJSON. Can also query a live Elasticsearch endpoint.

```bash
# File dump
ingest_logs(source="elastic", path="./dumps/errors.json")

# Live query
ingest_logs(source="elastic", endpoint="http://localhost:9200", index="app-logs", filter="level:error")
```

### SQLite Debug Tables

Reads from SQLite database files. Auto-maps columns by convention (`Timestamp`, `Level`, `Message`, `Exception`).

```bash
ingest_logs(source="sql", path="./debug.db", table="Logs", filter="Level = 'Error'")
```

### Flat Files

Parses common formats with ISO timestamps, log levels, and messages. Handles multi-line stack traces. Supports custom regex patterns.

```bash
ingest_logs(source="flatfile", path="./logs/app.log")
```

## Configuration

Optionally place a `log-intelligence.config.json` in your working directory to pre-configure sources:

```json
{
  "sources": [
    { "name": "app-logs", "type": "serilog", "path": "./logs/app.clef" },
    { "name": "db-errors", "type": "sql", "path": "./debug.db", "table": "Logs", "filter": "Level = 'Error'" }
  ],
  "defaults": {
    "bucketMinutes": 60,
    "anomalyThreshold": 2.0,
    "maxSamples": 3
  }
}
```

Pre-configured sources are automatically ingested when the server starts.

## How It Works

### Error Fingerprinting

Messages are normalised by stripping variable tokens (UUIDs, numbers, timestamps, paths, URLs, IPs, quoted strings), then SHA-256 hashed to produce a 16-character fingerprint. Entries sharing a fingerprint are grouped into error clusters.

### Anomaly Detection

Error entries are bucketed into time windows. The baseline mean and standard deviation are computed, and buckets where `count > mean + threshold * stddev` are flagged as anomalous. Each bucket gets a z-score for ranking.

### Regression Detection

Given a deployment date, the detector splits logs into before/after windows, clusters errors independently in each, then performs a set-diff to identify:
- **New errors** -- appeared only after deployment
- **Increased errors** -- existed before but rate increased >2x
- **Resolved errors** -- disappeared after deployment

## Sample Data

The `samples/` directory contains example log files for testing:
- `app.clef` -- Serilog CLEF format with a simulated deployment + Redis outage
- `webserver.log` -- Flat file format with Java stack traces
- `elastic-dump.json` -- Elasticsearch JSON dump
- `log-intelligence.config.json` -- Config to auto-ingest all samples

To test with sample data, copy the config to your working directory:

```bash
cp samples/log-intelligence.config.json .
npm start
```

## Development

```bash
# Run in dev mode with hot reload
npm run dev

# Type-check without emitting
npx tsc --noEmit
```

## License

MIT
