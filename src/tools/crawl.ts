/**
 * @module tools/crawl
 * @fileoverview MCP Tool: crawl -- BFS crawl from a URL, following links and collecting content.
 *
 * This tool performs a breadth-first search (BFS) crawl starting from a given URL.
 * It follows links on each page, fetches and extracts content, and collects
 * results until the token budget is exhausted or no more pages are available.
 *
 * ## Key Features
 * - **Token budget control**: Stops crawling when total collected tokens reach the limit
 * - **Domain restriction**: By default, only follows links within the start URL's domain
 * - **Pattern filtering**: Include/exclude URL patterns via glob syntax
 * - **BFS ordering**: Pages closer to the start URL are crawled first
 *
 * ## Usage Example (from MCP client)
 * ```json
 * {
 *   "tool": "crawl",
 *   "arguments": {
 *     "url": "https://docs.example.com",
 *     "max_tokens": 50000,
 *     "allowed_domains": ["docs.example.com"],
 *     "exclude_patterns": ["api-reference"]
 *   }
 * }
 * ```
 *
 * ## Response Format
 * The response contains:
 * - A summary header (start URL, pages collected, total tokens, max depth, stop reason)
 * - Each collected page as a separate section with its own metadata and content
 *
 * ## Stop Reasons
 * - `"token_budget_exhausted"`: Total tokens reached the max_tokens limit
 * - `"no_more_pages"`: All reachable pages within domain/pattern constraints have been crawled
 * - `"max_depth_reached"`: Hit the maximum BFS depth (configurable in crawler config)
 *
 * @see {@link runCrawl} for the BFS crawler implementation
 * @see {@link formatErrorForMcp} for error formatting
 */
import { z } from "zod";
import { crawl as runCrawl } from "../crawler/bfs-crawler.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { config } from "../config.js";

/**
 * Zod schema for the `crawl` tool parameters.
 *
 * This is a **plain object** with Zod fields -- NOT wrapped in `z.object()`.
 * The MCP SDK `server.tool()` method expects this shape directly.
 *
 * @property {string} url - Starting URL for the BFS crawl. Must be a valid URL.
 * @property {number} [max_tokens=100000] - Maximum total tokens to collect across
 *   all pages before stopping. Default is 100,000 (~400KB of text).
 * @property {string[]} [allowed_domains] - Whitelist of domains to crawl. If not
 *   specified, defaults to the domain of the start URL only.
 * @property {string[]} [exclude_patterns] - Glob patterns for URLs to skip.
 *   Example: `["login", "admin", ".pdf"]` (substring match patterns)
 * @property {string[]} [include_patterns] - Only follow URLs matching these patterns.
 *   If specified, URLs not matching any pattern are skipped.
 */
export const CrawlSchema = {
  /** Starting URL for the crawl -- must be a valid HTTP/HTTPS URL */
  url: z
    .string()
    .url()
    .describe("Starting URL for the crawl"),

  /**
   * Maximum total tokens to collect across all crawled pages.
   * The crawler stops once this budget is exhausted.
   * Default: 100,000 tokens (~400KB of text).
   */
  max_tokens: z
    .number()
    .optional()
    .default(100000)
    .describe("Maximum total tokens to collect (default: 100000)"),

  /**
   * Only crawl links pointing to these domains.
   * If omitted, defaults to the start URL's domain only.
   * Example: ["docs.example.com", "blog.example.com"]
   */
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe(
      "Only crawl links to these domains (default: start URL domain only)",
    ),

  /**
   * Glob patterns for URLs to skip during the crawl.
   * Any URL matching these patterns will not be fetched.
   * Example: ["login", ".pdf", "admin"]
   */
  exclude_patterns: z
    .array(z.string())
    .optional()
    .describe("Glob patterns for URLs to skip (e.g. 'login', '.pdf')"),

  /**
   * Only follow URLs matching these glob patterns.
   * If specified, URLs not matching any pattern are ignored.
   * Example: ["docs", "guide"]
   */
  include_patterns: z
    .array(z.string())
    .optional()
    .describe("Only follow URLs matching these glob patterns"),
};

/**
 * Parameter type for the crawl handler.
 * Represents the shape after Zod parsing & default application.
 */
interface CrawlParams {
  /** Starting URL for the BFS crawl */
  url: string;
  /** Token budget for the entire crawl */
  max_tokens: number;
  /** Optional domain whitelist */
  allowed_domains?: string[];
  /** Optional URL patterns to exclude */
  exclude_patterns?: string[];
  /** Optional URL patterns to include */
  include_patterns?: string[];
}

/**
 * Handler function for the `crawl` MCP tool.
 *
 * This function:
 * 1. Invokes the BFS crawler with the given parameters
 * 2. Builds a summary header with crawl statistics
 * 3. Formats each collected page with its metadata and content
 * 4. Returns everything as a single Markdown document
 *
 * The output is structured as:
 * ```
 * # Crawl Results
 * > Start URL: ...
 * > Pages collected: N
 * > Total tokens: N
 * > Max depth reached: N
 * > Stop reason: ...
 *
 * ---
 * ## Page 1: Page Title
 * > URL: ... | Depth: N | Tokens: N | Links: N
 *
 * [page content in Markdown]
 *
 * ---
 * ## Page 2: ...
 * ```
 *
 * @param params - The validated parameters from the MCP request
 * @param params.url - Starting URL for the crawl
 * @param params.max_tokens - Token budget
 * @param params.allowed_domains - Optional domain whitelist
 * @param params.exclude_patterns - Optional exclude patterns
 * @param params.include_patterns - Optional include patterns
 * @returns MCP tool response with content blocks
 *
 * @example
 * ```typescript
 * const result = await handleCrawl({
 *   url: "https://docs.example.com",
 *   max_tokens: 50000,
 *   allowed_domains: ["docs.example.com"],
 * });
 * // result.content[0].text contains the full crawl output
 * ```
 */
export async function handleCrawl(params: CrawlParams) {
  try {
    // ----- Step 1: Run the BFS crawler -----
    // The crawler will fetch pages breadth-first, extracting content and
    // following links until the token budget is exhausted.
    const result = await runCrawl(params.url, {
      maxTokens: params.max_tokens,
      allowedDomains: params.allowed_domains,
      excludePatterns: params.exclude_patterns,
      includePatterns: params.include_patterns,
    });

    // ----- Step 2: Build the summary header -----
    // This gives a quick overview of the crawl results at the top of the output.
    const summary = [
      `# Crawl Results`,
      `> Start URL: ${params.url}`,
      `> Pages collected: ${result.summary.total_pages}`,
      `> Total tokens: ${result.summary.total_tokens}`,
      `> Max depth reached: ${result.summary.max_depth_reached}`,
      `> Stop reason: ${result.summary.stopped_reason}`,
      "", // blank line separator
    ].join("\n");

    // ----- Step 3: Format each collected page -----
    // Each page gets its own section with a title, metadata, and content.
    // Pages are numbered sequentially (1-indexed) for easy reference.
    const pages = result.pages
      .map(
        (p, i) =>
          [
            `---`, // horizontal rule to separate pages
            `## Page ${i + 1}: ${p.title}`,
            `> URL: ${p.url} | Depth: ${p.depth} | Tokens: ${p.tokens} | Links: ${p.links_found}`,
            "", // blank line before content
            p.content,
          ].join("\n"),
      )
      .join("\n\n");

    // ----- Step 4: Return the combined response -----
    return {
      content: [{ type: "text" as const, text: summary + "\n" + pages }],
    };
  } catch (error) {
    // Return a structured error response for the MCP client
    return {
      content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
      isError: true,
    };
  }
}
