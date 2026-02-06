/**
 * @module tools/extract-links
 * @fileoverview MCP Tool: extract_links -- Extract and list all hyperlinks from a web page.
 *
 * This tool fetches a web page and extracts all `<a>` hyperlinks from it,
 * returning them as a formatted Markdown list. Links can be filtered by type:
 * - `"all"` (default): Return all links
 * - `"internal"`: Only links pointing to the same domain
 * - `"external"`: Only links pointing to different domains
 *
 * ## Usage Example (from MCP client)
 * ```json
 * {
 *   "tool": "extract_links",
 *   "arguments": {
 *     "url": "https://example.com",
 *     "filter": "external"
 *   }
 * }
 * ```
 *
 * ## Response Format
 * The response is a single text content block containing:
 * - A header showing the source URL
 * - A count of total links found
 * - A Markdown list of links, each with text and URL
 * - External links are annotated with "(external)"
 *
 * @see {@link safeFetch} for the HTTP fetch wrapper
 * @see {@link resolveLinks} for the link extraction and resolution logic
 */
import { z } from "zod";
import { safeFetch } from "../services/fetch.js";
import { extractLinks as resolveLinks } from "../crawler/link-resolver.js";
import { formatErrorForMcp } from "../utils/errors.js";

/**
 * Zod schema for the `extract_links` tool parameters.
 *
 * This is a **plain object** with Zod fields -- NOT wrapped in `z.object()`.
 * The MCP SDK `server.tool()` method expects this shape directly.
 *
 * @property {string} url - The URL to extract links from. Must be a valid URL.
 * @property {("internal"|"external"|"all")} [filter="all"] - Filter links by type.
 *   - `"internal"`: Only same-domain links
 *   - `"external"`: Only cross-domain links
 *   - `"all"`: All links (default)
 */
export const ExtractLinksSchema = {
  /** URL to extract links from -- must be a valid HTTP/HTTPS URL */
  url: z
    .string()
    .url()
    .describe("URL to extract links from"),

  /**
   * Filter links by type:
   * - "internal": same-domain links only
   * - "external": cross-domain links only
   * - "all": no filtering (default)
   */
  filter: z
    .enum(["internal", "external", "all"])
    .optional()
    .default("all")
    .describe("Filter links by type"),
};

/**
 * Parameter type for the extract_links handler.
 * Represents the shape after Zod parsing & default application.
 */
interface ExtractLinksParams {
  /** The URL to extract links from */
  url: string;
  /** Link filter mode */
  filter: "internal" | "external" | "all";
}

/**
 * Handler function for the `extract_links` MCP tool.
 *
 * This function:
 * 1. Fetches the target URL's HTML via {@link safeFetch}
 * 2. Extracts and resolves all `<a>` links via {@link resolveLinks}
 * 3. Applies the filter (internal/external/all)
 * 4. Formats the result as a Markdown list
 *
 * Links without visible text are displayed as "(no text)" to ensure
 * every link is represented in the output.
 *
 * External links are annotated with "(external)" for easy identification.
 *
 * @param params - The validated parameters from the MCP request
 * @param params.url - Target URL to extract links from
 * @param params.filter - Link filter mode: "internal", "external", or "all"
 * @returns MCP tool response with content blocks
 *
 * @example
 * ```typescript
 * const result = await handleExtractLinks({
 *   url: "https://example.com",
 *   filter: "external",
 * });
 * // result.content[0].text contains a Markdown list of external links
 * ```
 */
export async function handleExtractLinks(params: ExtractLinksParams) {
  try {
    // ----- Step 1: Fetch the raw HTML from the target URL -----
    // safeFetch handles timeouts, redirects, and error responses gracefully.
    const fetched = await safeFetch(params.url);

    // ----- Step 2: Extract and resolve all links -----
    // resolveLinks parses the HTML, extracts <a> elements, resolves relative
    // URLs to absolute ones, and applies the internal/external filter.
    const links = resolveLinks(fetched.html, fetched.url, {
      filter: params.filter,
    });

    // ----- Step 3: Format each link as a Markdown list item -----
    // Links with no visible text get a "(no text)" placeholder.
    // External links are annotated for clarity.
    const lines = links.map(
      (l) =>
        `- [${l.text || "(no text)"}](${l.url})${l.isInternal ? "" : " (external)"}`,
    );

    // ----- Step 4: Build the final response text -----
    const text = [
      `# Links from ${fetched.url}`,
      "",
      `Found ${links.length} links (filter: ${params.filter})`,
      "",
      lines.join("\n"),
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (error) {
    // Return a structured error response so the MCP client gets a clean error
    return {
      content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
      isError: true,
    };
  }
}
