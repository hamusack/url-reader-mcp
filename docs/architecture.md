# Architecture — url-reader-mcp

## Overview

stdio-based MCP server. Single bundled entry point (`build/index.js`). Three tools: `read_url`, `crawl`, `extract_links`.

## Module Dependency Graph

```
                     ┌─────────────┐
                     │  index.ts   │  Server entry point
                     │  (McpServer)│
                     └──────┬──────┘
                            │ registers tools
              ┌─────────────┼─────────────┐
              v             v             v
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │ read-url │  │  crawl   │  │extract-links │  tools/
        └────┬─────┘  └────┬─────┘  └──────┬───────┘
             │             │               │
             v             v               v
      ┌──────────┐  ┌──────────────┐ ┌──────────────┐
      │ pipeline │  │ bfs-crawler  │ │link-resolver │  extractor/ & crawler/
      └────┬─────┘  └──┬───┬──────┘ └──────┬───────┘
           │           │   │               │
           │     ┌─────┘   │               │
           v     v         v               v
      ┌─────────┐  ┌──────────────┐  ┌──────────┐
      │  fetch  │  │token-counter │  │  fetch   │    services/
      └────┬────┘  └──────────────┘  └────┬─────┘
           │                              │
           v                              v
      ┌─────────┐  ┌─────────┐      ┌─────────┐
      │  cache  │  │  queue  │      │ network │    services/ & utils/
      └─────────┘  └─────────┘      └─────────┘
           │            │                │
           v            v                v
      ┌────────────────────────────────────────┐
      │              config.ts                  │  Bottom of graph
      └────────────────────────────────────────┘
```

**Rule**: `config.ts` and `utils/` are leaf modules. They import nothing from the application. All other modules may import them.

## Directory Structure

```
src/
├── index.ts                  # Server init + tool registration (McpServer + StdioServerTransport)
├── config.ts                 # Env vars → AppConfig singleton (zero-config defaults)
├── tools/                    # MCP tool definitions (schema + handler per file)
│   ├── read-url.ts           #   read_url: single URL → Markdown
│   ├── crawl.ts              #   crawl: BFS multi-page with token budget
│   └── extract-links.ts      #   extract_links: link list from a page
├── extractor/                # HTML → Markdown pipeline
│   ├── html-extractor.ts     #   cheerio preprocessing + Readability article extraction
│   ├── markdown-converter.ts #   turndown HTML → Markdown + cleanup
│   └── pipeline.ts           #   Orchestrates: fetch → extract → convert
├── crawler/                  # Multi-page crawling engine
│   ├── bfs-crawler.ts        #   BFS engine with token budget, domain scope
│   ├── link-resolver.ts      #   Link discovery, URL resolution, filtering
│   └── token-counter.ts      #   Token estimation (CJK-aware, ~4 chars/token)
├── services/                 # Cross-cutting infrastructure
│   ├── fetch.ts              #   Secure HTTP client (SSRF check, timeout, size limit, redirects)
│   ├── cache.ts              #   node-cache wrapper with TTL
│   └── queue.ts              #   p-queue concurrency control (global + per-domain)
└── utils/                    # Pure utility functions
    ├── errors.ts             #   Error class hierarchy (UrlReaderError base)
    ├── url.ts                #   URL normalization, domain extraction, pattern matching
    └── network.ts            #   SSRF protection (private IP range detection)
```

## Data Flow

### read_url

```
Client request { url, max_length?, include_links? }
  → tools/read-url.ts (validate params)
  → extractor/pipeline.ts:extractPage()
    → services/cache.ts (check cache)
    → services/queue.ts (wait for slot)
    → services/fetch.ts:secureFetch() (SSRF check → HTTP GET → stream body)
    → extractor/html-extractor.ts:extractArticle() (cheerio clean → Readability)
    → extractor/markdown-converter.ts:convertToMarkdown() (turndown)
    → services/cache.ts (store result)
  → Truncate to max_length
  → Format response with metadata header
  → Return MCP text content
```

### crawl

```
Client request { url, max_tokens?, allowed_domains?, patterns? }
  → tools/crawl.ts (validate params)
  → crawler/bfs-crawler.ts:crawl()
    → Initialize BFS queue with start URL
    → Loop while queue not empty AND tokens < budget:
      → Dequeue next URL
      → extractor/pipeline.ts:extractPage() (same flow as read_url)
      → crawler/token-counter.ts:countTokens() (estimate token count)
      → crawler/link-resolver.ts:resolveLinks() (discover + filter links)
      → Enqueue new links that match domain/pattern constraints
    → Return all collected pages with crawl stats
  → Format aggregated Markdown
  → Return MCP text content
```

### extract_links

```
Client request { url, filter? }
  → tools/extract-links.ts (validate params)
  → services/fetch.ts:secureFetch() (get raw HTML)
  → crawler/link-resolver.ts:extractAndResolveLinks()
    → cheerio parse HTML
    → Resolve relative URLs to absolute
    → Categorize: internal vs external
    → Apply filter (all/internal/external)
  → Format as Markdown link list
  → Return MCP text content
```

## Error Flow

```
Any module throws UrlReaderError subclass
  → Handler catches in try/catch
  → formatErrorForMcp(error) creates { content: [{ type: "text", text }], isError: true }
  → MCP client receives error response with machine-readable code
```

Error classes: `FetchError`, `SecurityError`, `ExtractionError`, `TimeoutError`, `TokenLimitError`.

## Configuration

All env vars with defaults — see `config.ts`. Key ones:

| Env Var | Default | What it controls |
|---------|---------|-----------------|
| `DEFAULT_MAX_LENGTH` | 50000 | read_url output char limit |
| `DEFAULT_MAX_TOKENS` | 100000 | crawl token budget |
| `FETCH_TIMEOUT` | 10000 | HTTP timeout (ms) |
| `CACHE_TTL` | 3600 | Cache TTL (seconds) |
| `MAX_CONCURRENT` | 3 | Global concurrent requests |
| `PER_DOMAIN_INTERVAL` | 2000 | Per-domain rate limit (ms) |
| `MAX_RESPONSE_SIZE` | 10485760 | Max HTTP response body (bytes) |
| `MAX_REDIRECTS` | 5 | Max redirect hops |
| `USER_AGENT` | `mcp-url-reader/1.0 (MCP Server)` | HTTP User-Agent |

## Build Pipeline

```
src/**/*.ts
  → esbuild (build.ts)
    - entryPoints: ["./src/index.ts"]
    - bundle: true, minify: true
    - platform: "node", target: "node18"
    - format: "esm"
    - banner: createRequire shim (for packages using require())
    - external: ["jsdom"] (can't bundle its dynamic worker file)
  → build/index.js (single file, ~2.5MB, shebang + executable)
```

## Transport

- **stdio only** (StdioServerTransport). Server reads JSON-RPC from stdin, writes to stdout.
- Designed for subprocess launch by MCP clients (Claude Code, Claude Desktop).
- Phase 3 roadmap: HTTP/SSE transport for remote access.
