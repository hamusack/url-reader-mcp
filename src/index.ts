/**
 * @module index
 * @fileoverview mcp-url-reader MCP server entry point.
 *
 * This is the main entry point for the mcp-url-reader MCP server. It creates
 * an {@link McpServer} instance, registers all available tools, and starts
 * listening on stdio transport.
 *
 * ## Startup Flow
 * 1. Load configuration from environment variables (via {@link config})
 * 2. Create {@link McpServer} instance with name and version
 * 3. Register 3 tools: `read_url`, `crawl`, `extract_links`
 * 4. Connect via {@link StdioServerTransport} for stdio-based communication
 *
 * ## Available Tools
 * | Tool           | Description                                       | Module                    |
 * |----------------|---------------------------------------------------|---------------------------|
 * | `read_url`     | Fetch a URL and return content as clean Markdown   | `./tools/read-url.js`     |
 * | `crawl`        | BFS crawl with token budget control                | `./tools/crawl.js`        |
 * | `extract_links`| List all links on a page (internal/external/all)   | `./tools/extract-links.js`|
 *
 * ## Architecture
 * ```
 * MCP Client (e.g., Claude Desktop)
 *   |
 *   | stdio (JSON-RPC over stdin/stdout)
 *   v
 * index.ts (this file) -- McpServer
 *   |
 *   +-- read_url    --> extractor/pipeline.ts --> services/fetch.ts
 *   +-- crawl       --> crawler/bfs-crawler.ts --> extractor/pipeline.ts
 *   +-- extract_links --> crawler/link-resolver.ts --> services/fetch.ts
 * ```
 *
 * ## Extension Points
 * - **Add new tools**: Create a file in `tools/` with schema + handler, then
 *   register it here with `server.tool()`.
 * - **Phase 2**: Add MCP resources (e.g., crawl session history, cached pages)
 * - **Phase 3**: Add HTTP/SSE transport alongside stdio for remote access
 *
 * ## Environment Variables
 * See {@link config} for all supported environment variables:
 * - `MCP_URL_READER_USER_AGENT` - Custom User-Agent string
 * - `MCP_URL_READER_TIMEOUT_MS` - HTTP request timeout in milliseconds
 * - `MCP_URL_READER_MAX_BODY_SIZE` - Maximum response body size in bytes
 * - `MCP_URL_READER_CACHE_TTL_S` - Cache TTL in seconds
 * - And more...
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import tool schemas and handlers from the tools/ directory.
// Each tool module exports a Zod schema (plain object shape) and an async handler.
import { ReadUrlSchema, handleReadUrl } from "./tools/read-url.js";
import { CrawlSchema, handleCrawl } from "./tools/crawl.js";
import {
  ExtractLinksSchema,
  handleExtractLinks,
} from "./tools/extract-links.js";

// ---------------------------------------------------------------------------
// Server Initialization
// ---------------------------------------------------------------------------

/**
 * The MCP server instance for mcp-url-reader.
 *
 * Configured with:
 * - `name`: "mcp-url-reader" -- identifies this server to MCP clients
 * - `version`: "1.0.0" -- semantic version of the server
 * - `capabilities.tools`: Enables the tools capability so clients can
 *   discover and invoke our registered tools
 */
const server = new McpServer(
  {
    name: "mcp-url-reader",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------
// Each tool is registered using the server.tool() method, following the
// pattern from mcp-github-projects:
//   server.tool("tool-name", "description", SchemaObject, handlerFn)
//
// The schema is a plain object with Zod fields (NOT wrapped in z.object()).
// The handler receives the parsed & validated params and returns an MCP response.
// ---------------------------------------------------------------------------

/**
 * Tool: read_url
 *
 * Fetches a single URL and returns its content as clean Markdown.
 * Uses Mozilla's Readability algorithm to extract the main article content,
 * strips out navigation, ads, sidebars, and other noise, then converts
 * the cleaned HTML to Markdown format.
 *
 * @see {@link ReadUrlSchema} for parameter definitions
 * @see {@link handleReadUrl} for the handler implementation
 */
server.tool(
  "read_url",
  "Fetch a URL and return its content as clean Markdown. Extracts the main article content, removes navigation/ads/noise, and converts to Markdown format.",
  ReadUrlSchema,
  handleReadUrl,
);

/**
 * Tool: crawl
 *
 * Starting from a URL, follows links recursively using breadth-first search
 * (BFS) and collects page content. The crawler respects a token budget --
 * it stops when the total collected tokens across all pages reaches the
 * specified limit. This prevents runaway crawls on large sites.
 *
 * By default, only links within the start URL's domain are followed.
 * This can be customized via `allowed_domains`, `exclude_patterns`,
 * and `include_patterns`.
 *
 * @see {@link CrawlSchema} for parameter definitions
 * @see {@link handleCrawl} for the handler implementation
 */
server.tool(
  "crawl",
  "Starting from a URL, follow links recursively (BFS) and collect page content. Stops when the token budget is exhausted. Returns all collected pages as Markdown.",
  CrawlSchema,
  handleCrawl,
);

/**
 * Tool: extract_links
 *
 * Extracts all hyperlinks (`<a>` elements) from a web page and returns
 * them as a formatted Markdown list. Links can be filtered to show only
 * internal (same-domain), external (cross-domain), or all links.
 *
 * This is useful for:
 * - Discovering linked resources before a full crawl
 * - Analyzing a page's link structure
 * - Finding external references from a documentation page
 *
 * @see {@link ExtractLinksSchema} for parameter definitions
 * @see {@link handleExtractLinks} for the handler implementation
 */
server.tool(
  "extract_links",
  "Extract all hyperlinks from a web page. Returns a list of links with their text and URLs, optionally filtered by internal/external.",
  ExtractLinksSchema,
  handleExtractLinks,
);

// ---------------------------------------------------------------------------
// Server Startup
// ---------------------------------------------------------------------------

/**
 * Main entry point -- creates a stdio transport and connects the server.
 *
 * The {@link StdioServerTransport} enables communication over stdin/stdout,
 * which is the standard transport for MCP servers launched as subprocesses
 * by MCP clients (e.g., Claude Desktop, Claude Code).
 *
 * ## Error Handling
 * If the server fails to start (e.g., transport error, port conflict),
 * the error is logged to stderr and the process exits with code 1.
 *
 * @throws {Error} If the transport connection fails
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Start the server and handle fatal errors
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
