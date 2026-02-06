# CLAUDE.md — url-reader-mcp

MCP server that reads, crawls, and extracts links from web pages. Returns clean Markdown.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Bundle to build/index.js (esbuild, single file + shebang)
bun test             # Run all tests (148 tests, Bun test runner)
bun run dev          # Run src/index.ts directly (dev mode, no bundle)
```

## Architecture

```
index.ts (McpServer + tool registration)
  ├── tools/read-url.ts     → extractor/pipeline.ts → services/fetch.ts
  ├── tools/crawl.ts        → crawler/bfs-crawler.ts → extractor/pipeline.ts
  └── tools/extract-links.ts → crawler/link-resolver.ts → services/fetch.ts

Shared foundations:
  config.ts   — All env vars, singleton export. Bottom of dependency graph.
  utils/      — errors.ts (custom hierarchy), url.ts, network.ts (SSRF)
  services/   — cache.ts (node-cache), queue.ts (p-queue), fetch.ts (secure HTTP)
```

Detailed specs: @docs/architecture.md

## Key Conventions

- **MCP SDK v1.6.1 pattern**: Schema is a plain Zod object `{ url: z.string() }`, NOT `z.object({...})`. Register with `server.tool("name", "description", Schema, handler)`.
- **Tool modules**: Each file in `tools/` exports `XxxSchema` (Zod shape) + `handleXxx` (async handler). Handler returns `{ content: [{ type: "text", text: string }] }`.
- **Error handling**: All errors extend `UrlReaderError` (base). Use `formatErrorForMcp(error)` in handlers to create MCP error responses with `isError: true`.
- **Config**: All env vars flow through `config.ts` singleton. Never read `process.env` elsewhere.
- **Imports**: Always use `.js` extension in import paths (NodeNext module resolution). Example: `import { config } from "./config.js"`.

Detailed patterns: @docs/conventions.md

## Build Gotchas

- **esbuild format is ESM** (`format: "esm"`). A `createRequire` shim is injected via `banner` to support packages that use `require()` at runtime.
- **jsdom is `external`** in esbuild config. It loads `xhr-sync-worker.js` dynamically at runtime, which can't be bundled. It must exist in `node_modules/`.
- **Both fixes are required together** — removing either one breaks the build.
- **JSDoc comments must not contain `*/`** (e.g., glob patterns like `["*/login/*"]`). esbuild misinterprets it as comment-end. Use simpler examples.

## Testing

- Tests live in `tests/` mirroring `src/` structure.
- Test runner: **Bun** (`bun test`), not Vitest/Jest.
- Use `describe()` / `it()` / `expect()` — Bun's built-in test API.
- All test URLs use `example.com`. Never use real URLs.
- No mocking framework needed — tests target pure logic (URL parsing, HTML extraction, token counting).

## Security

- **SSRF protection**: `utils/network.ts` blocks private IPs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7) before any HTTP request.
- **Content-Type validation**: Only HTML-like types accepted (text/html, application/xhtml+xml, etc).
- **Size limits**: Streaming response with byte counting. Configurable via `MAX_RESPONSE_SIZE`.
- **Rate limiting**: Global concurrency (p-queue) + per-domain interval. Prevents abuse.

## Adding a New Tool

1. Create `src/tools/my-tool.ts` — export `MyToolSchema` (plain Zod object) + `handleMyTool` (async handler)
2. Register in `src/index.ts`: `server.tool("my_tool", "Description", MyToolSchema, handleMyTool)`
3. Add tests in `tests/tools/my-tool.test.ts`
4. Rebuild: `bun run build`
