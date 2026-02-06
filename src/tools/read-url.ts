/**
 * @module tools/read-url
 * @fileoverview MCP Tool: read_url -- Fetch a single URL and return its content as Markdown.
 *
 * This tool is the primary entry point for reading web pages. It:
 * 1. Fetches the target URL via {@link extractPage}
 * 2. Extracts the main article content (removing ads, navigation, etc.)
 * 3. Converts the cleaned HTML to Markdown format
 * 4. Optionally appends a list of links found on the page
 * 5. Returns the result with metadata (title, author, excerpt, length)
 *
 * ## Usage Example (from MCP client)
 * ```json
 * {
 *   "tool": "read_url",
 *   "arguments": {
 *     "url": "https://example.com/article",
 *     "max_length": 30000,
 *     "include_links": true
 *   }
 * }
 * ```
 *
 * ## Response Format
 * The response is a single text content block containing:
 * - A metadata header (title, URL, author, summary, length, cache status)
 * - The extracted Markdown content
 * - An optional "Links found on this page" section
 *
 * @see {@link extractPage} for the extraction pipeline
 * @see {@link formatErrorForMcp} for error formatting
 */
import { z } from "zod";
import { extractPage } from "../extractor/pipeline.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { config } from "../config.js";

/**
 * Zod schema for the `read_url` tool parameters.
 *
 * This is a **plain object** with Zod fields -- NOT wrapped in `z.object()`.
 * The MCP SDK `server.tool()` method expects this shape directly.
 *
 * @property {string} url - The target URL to fetch and convert to Markdown.
 *   Must be a valid URL (validated by `z.string().url()`).
 * @property {number} [max_length=50000] - Maximum character count for the
 *   returned content. Content exceeding this limit will be truncated.
 *   Default is 50,000 characters (~12,500 tokens).
 * @property {boolean} [include_links=true] - Whether to preserve Markdown-style
 *   links in the output and append a "Links found" section at the end.
 */
export const ReadUrlSchema = {
  /** Target URL to read -- must be a valid HTTP/HTTPS URL */
  url: z
    .string()
    .url()
    .describe("Target URL to read"),

  /** Maximum character count for returned content (default: 50000) */
  max_length: z
    .number()
    .optional()
    .default(50000)
    .describe(
      "Maximum character count for returned content (default: 50000)",
    ),

  /** Whether to preserve Markdown links in output (default: true) */
  include_links: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to preserve Markdown links in output"),
};

/**
 * Parameter type inferred from {@link ReadUrlSchema}.
 * Used as the handler's input shape after Zod parsing & defaults are applied.
 */
interface ReadUrlParams {
  /** The URL to fetch */
  url: string;
  /** Max characters to return */
  max_length: number;
  /** Whether to include links in output */
  include_links: boolean;
}

/**
 * Handler function for the `read_url` MCP tool.
 *
 * This function:
 * 1. Calls {@link extractPage} to fetch and extract the page content
 * 2. Builds a structured metadata header with title, URL, author, etc.
 * 3. Optionally appends a list of links found on the page (capped at 50)
 * 4. Returns the result as an MCP-compliant content block
 *
 * On error, it returns an `isError: true` response with a formatted error
 * message instead of throwing, so the MCP client receives a clean error.
 *
 * @param params - The validated parameters from the MCP request
 * @param params.url - Target URL to fetch
 * @param params.max_length - Maximum output character count
 * @param params.include_links - Whether to include a links section
 * @returns MCP tool response with content blocks
 *
 * @example
 * ```typescript
 * const result = await handleReadUrl({
 *   url: "https://example.com",
 *   max_length: 50000,
 *   include_links: true,
 * });
 * // result.content[0].text contains the Markdown output
 * ```
 */
export async function handleReadUrl(params: ReadUrlParams) {
  try {
    // ----- Step 1: Extract page content via the extraction pipeline -----
    const result = await extractPage(params.url, {
      maxLength: params.max_length,
      includeLinks: params.include_links,
    });

    // ----- Step 2: Build the metadata header -----
    // The header provides quick-glance information about the extracted page.
    // Null/undefined values are filtered out so we don't show empty lines.
    const meta = [
      `# ${result.title}`,
      `> URL: ${result.url}`,
      result.byline ? `> Author: ${result.byline}` : null,
      result.excerpt ? `> Summary: ${result.excerpt}` : null,
      `> Length: ${result.length} characters`,
      result.fromCache ? `> (from cache)` : null,
      "", // blank line separator between meta and content
    ]
      .filter(Boolean)
      .join("\n");

    // Combine metadata header with the extracted Markdown content
    const text = meta + "\n" + result.content;

    // ----- Step 3: Optionally append a "Links found" section -----
    // We cap at 50 links to avoid overwhelming the output.
    // Each link is formatted as a Markdown list item.
    let linksSection = "";
    if (params.include_links && result.links.length > 0) {
      linksSection =
        "\n\n---\n## Links found on this page\n" +
        result.links
          .slice(0, 50) // Cap at 50 links to keep output manageable
          .map((l) => `- [${l.text}](${l.url})`)
          .join("\n");
    }

    // ----- Step 4: Return the MCP-compliant response -----
    return {
      content: [{ type: "text" as const, text: text + linksSection }],
    };
  } catch (error) {
    // Return a structured error response rather than throwing.
    // This ensures the MCP client gets a readable error message.
    return {
      content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
      isError: true,
    };
  }
}
