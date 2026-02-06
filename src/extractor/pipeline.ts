/**
 * @fileoverview Content extraction pipeline — the orchestration layer.
 *
 * This module integrates the entire content extraction workflow into a
 * single, high-level function: {@link extractPage}. It coordinates:
 *
 *   1. **Cache lookup** — Check if we've already processed this URL.
 *   2. **HTTP fetch** — Download the raw HTML via {@link safeFetch}.
 *   3. **Content extraction** — Run Readability to isolate the article body.
 *   4. **Markdown conversion** — Convert the article HTML to clean Markdown.
 *   5. **Link extraction** — Parse all hyperlinks from the original HTML.
 *   6. **Cache storage** — Save the result for future requests.
 *
 * **Why a separate pipeline module?**
 *   Separation of concerns. The html-extractor and markdown-converter are
 *   pure, synchronous, stateless functions. The pipeline adds the async
 *   I/O layer (HTTP, caching) and link extraction on top, keeping each
 *   module focused on a single responsibility.
 *
 * **Caching strategy:**
 *   Results are cached by URL (normalized) so that repeated requests for
 *   the same page don't incur additional network I/O. This is especially
 *   important in the MCP context where an LLM might request the same page
 *   multiple times during a conversation (e.g., first to summarize, then
 *   to extract specific details).
 *
 * @module extractor/pipeline
 */

import * as cheerio from "cheerio";
import { safeFetch } from "../services/fetch.js";
import { extractFromHtml } from "./html-extractor.js";
import { htmlToMarkdown } from "./markdown-converter.js";
import { cacheManager } from "../services/cache.js";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * The final result of processing a web page through the extraction pipeline.
 *
 * This is the top-level data structure returned to MCP tool handlers and
 * ultimately consumed by the LLM. It contains everything the model needs
 * to understand and reference the page content.
 *
 * @example
 * ```typescript
 * const result = await extractPage("https://example.com/article");
 *
 * console.log(result.title);     // "How to Build MCP Servers"
 * console.log(result.content);   // "# How to Build MCP Servers\n\n..."
 * console.log(result.fromCache); // false (first request)
 *
 * // Second request hits cache
 * const cached = await extractPage("https://example.com/article");
 * console.log(cached.fromCache); // true
 * ```
 */
export interface PageResult {
  /** The original URL that was fetched. */
  url: string;

  /** The page/article title. */
  title: string;

  /**
   * The page content as Markdown.
   *
   * This is the main payload — a clean, LLM-optimized Markdown
   * representation of the article's body content. All boilerplate
   * (navigation, ads, footers) has been stripped.
   */
  content: string;

  /** The author/byline, if detected. */
  byline?: string;

  /** A brief excerpt or summary of the article. */
  excerpt?: string;

  /**
   * Character count of the Markdown content.
   *
   * Useful for estimating token usage and deciding whether truncation
   * is needed before sending to an LLM.
   */
  length: number;

  /**
   * All hyperlinks found on the page.
   *
   * Each entry contains the visible link text and the resolved absolute
   * URL. This is used by the crawler module to discover linked pages
   * and by the MCP tool to provide navigation context to the LLM.
   *
   * Links are deduplicated by URL, and non-fetchable URLs (javascript:,
   * mailto:, tel:, data:, #anchors) are filtered out.
   */
  links: Array<{ text: string; url: string }>;

  /**
   * Whether this result was served from cache.
   *
   * The MCP tool can use this flag to inform the LLM that the content
   * may not reflect the absolute latest version of the page.
   */
  fromCache: boolean;
}

/**
 * Options for controlling the extraction pipeline's behavior.
 *
 * @example
 * ```typescript
 * // Extract with 8K character limit and no links in the Markdown body
 * const result = await extractPage("https://example.com", {
 *   maxLength: 8000,
 *   includeLinks: false,
 * });
 * ```
 */
export interface PipelineOptions {
  /**
   * Maximum character length of the Markdown content.
   *
   * When set, the Markdown output is truncated at the nearest word
   * boundary to fit within this limit. Useful for keeping responses
   * within LLM context windows.
   */
  maxLength?: number;

  /**
   * Whether to include hyperlinks in the Markdown output.
   *
   * - `true` (default): Links rendered as `[text](url)`.
   * - `false`: Links replaced with just their anchor text.
   */
  includeLinks?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * URL schemes that we filter out from the extracted links array.
 *
 * **Why filter these?**
 * - `javascript:` — Not navigable, often XSS vectors.
 * - `mailto:` — Email addresses, not web pages.
 * - `tel:` — Phone numbers.
 * - `data:` — Inline data URIs (images, etc.), not navigable pages.
 * - `blob:` — In-memory object URLs, not fetchable.
 *
 * We keep `http:`, `https:`, and protocol-relative URLs (`//`).
 */
const NON_FETCHABLE_SCHEMES: readonly string[] = [
  "javascript:",
  "mailto:",
  "tel:",
  "data:",
  "blob:",
  "ftp:",
] as const;

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially relative URL against a base URL.
 *
 * This handles all common relative URL patterns:
 *   - Absolute URLs (`https://...`) — returned as-is.
 *   - Protocol-relative (`//cdn.example.com/...`) — resolved with base protocol.
 *   - Root-relative (`/path/to/page`) — resolved against base origin.
 *   - Relative (`../other-page`, `./sibling`) — resolved against base path.
 *
 * If resolution fails (e.g., malformed URL), returns `null` rather than
 * throwing, because a single bad link should not abort the entire pipeline.
 *
 * @param href    - The href attribute value from an `<a>` tag.
 * @param baseUrl - The URL of the page containing the link.
 * @returns The resolved absolute URL, or `null` if resolution failed.
 *
 * @example
 * ```typescript
 * resolveUrl("/about", "https://example.com/blog/post");
 * // Returns: "https://example.com/about"
 *
 * resolveUrl("https://other.com/page", "https://example.com");
 * // Returns: "https://other.com/page"
 *
 * resolveUrl("javascript:void(0)", "https://example.com");
 * // Returns: null (filtered as non-fetchable)
 * ```
 */
function resolveUrl(href: string, baseUrl: string): string | null {
  // Quick rejection: skip empty hrefs and pure fragment links.
  // Fragment links (#section) point to the same page and are not useful
  // for crawling or navigation context.
  if (!href || href.startsWith("#")) {
    return null;
  }

  // Quick rejection: skip non-fetchable URL schemes.
  const hrefLower = href.toLowerCase().trim();
  for (const scheme of NON_FETCHABLE_SCHEMES) {
    if (hrefLower.startsWith(scheme)) {
      return null;
    }
  }

  try {
    // The URL constructor handles all relative resolution when given a base.
    // This is the most spec-compliant way to resolve URLs in Node.js.
    const resolved = new URL(href, baseUrl);

    // Only keep http/https URLs — anything else that slipped through
    // (e.g., custom protocol handlers) is not something we can fetch.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    // Strip the fragment (hash) from the resolved URL because:
    //   1. Fragments are client-side only and don't affect the HTTP request.
    //   2. Keeping them would create duplicate entries for the same page
    //      (e.g., /page#section1 and /page#section2 are the same resource).
    resolved.hash = "";

    return resolved.href;
  } catch {
    // URL constructor throws on truly malformed input. We silently skip
    // these rather than failing the entire extraction.
    return null;
  }
}

/**
 * Extract all hyperlinks from raw HTML using cheerio.
 *
 * **Why extract links from the ORIGINAL HTML (not the Readability output)?**
 *   Readability strips many elements it considers "non-content", which can
 *   include navigation links, "related articles" sections, and sidebar links
 *   that are actually valuable for crawling and navigation context. By
 *   extracting links from the original HTML, we capture a more complete
 *   picture of the page's link topology.
 *
 * **Deduplication:**
 *   Pages often contain the same link multiple times (e.g., in both the nav
 *   and the article body, or in a "related articles" section). We deduplicate
 *   by resolved URL to keep the list concise. When duplicates exist, we keep
 *   the first occurrence's anchor text (which is typically more descriptive
 *   than the link text in nav menus).
 *
 * @param html    - The raw (unprocessed) HTML of the page.
 * @param baseUrl - The page's URL, used for resolving relative links.
 * @returns An array of unique `{ text, url }` objects.
 *
 * @example
 * ```typescript
 * const html = `
 *   <a href="/about">About Us</a>
 *   <a href="https://example.com/contact">Contact</a>
 *   <a href="javascript:void(0)">Click</a>
 * `;
 * const links = extractLinks(html, "https://example.com");
 * // Returns: [
 * //   { text: "About Us", url: "https://example.com/about" },
 * //   { text: "Contact", url: "https://example.com/contact" },
 * // ]
 * // Note: javascript: link is filtered out
 * ```
 */
function extractLinks(
  html: string,
  baseUrl: string,
): Array<{ text: string; url: string }> {
  const $ = cheerio.load(html);
  const links: Array<{ text: string; url: string }> = [];

  // Track seen URLs for deduplication. Using a Set for O(1) lookups
  // because pages can have hundreds of links.
  const seenUrls = new Set<string>();

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    // Resolve relative URLs and filter out non-fetchable schemes.
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved) return;

    // Deduplicate by resolved URL.
    if (seenUrls.has(resolved)) return;
    seenUrls.add(resolved);

    // Extract and normalize the anchor text.
    // - Use .text() to get the visible text (strips nested HTML).
    // - Normalize whitespace: collapse internal whitespace and trim.
    // - If the anchor has no visible text (e.g., an image link), use
    //   the URL itself as a fallback — this ensures every link entry
    //   has a non-empty text field.
    const rawText = $(element).text().replace(/\s+/g, " ").trim();
    const text = rawText || resolved;

    links.push({ text, url: resolved });
  });

  return links;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract page content as Markdown from a URL.
 *
 * This is the primary entry point for the extraction pipeline and the
 * function that MCP tool handlers should call. It orchestrates the full
 * workflow: cache check → fetch → extract → convert → cache store.
 *
 * **Error handling:**
 *   This function deliberately does NOT catch errors from `safeFetch` or
 *   the extraction/conversion steps. Errors bubble up to the MCP tool
 *   handler, which is responsible for formatting error responses. This
 *   follows the "let it crash" principle — the caller knows best how to
 *   handle and present errors to the user.
 *
 * **Concurrency:**
 *   Multiple concurrent calls with the same URL are safe. The cache
 *   check is synchronous (in-memory), so at worst two concurrent calls
 *   may both miss the cache and fetch the same URL twice. The second
 *   fetch result will simply overwrite the first in the cache, which is
 *   harmless since the content is identical.
 *
 * @param url     - The URL of the web page to extract content from.
 *                  Must be a valid http:// or https:// URL.
 * @param options - Optional settings for the extraction pipeline.
 *                  See {@link PipelineOptions}.
 * @returns A Promise resolving to a {@link PageResult} containing the
 *          extracted Markdown content, metadata, and discovered links.
 *
 * @throws {Error} If the URL cannot be fetched (network error, HTTP error,
 *         timeout, blocked by robots.txt, etc.). The specific error type
 *         depends on the `safeFetch` implementation.
 *
 * @example Basic usage
 * ```typescript
 * import { extractPage } from "./pipeline.js";
 *
 * const result = await extractPage("https://example.com/article");
 * console.log(result.title);     // "My Article"
 * console.log(result.content);   // "# My Article\n\nArticle body..."
 * console.log(result.links);     // [{ text: "Related", url: "..." }, ...]
 * console.log(result.fromCache); // false
 * ```
 *
 * @example With options
 * ```typescript
 * const result = await extractPage("https://example.com/article", {
 *   maxLength: 5000,
 *   includeLinks: false,
 * });
 * // result.content is truncated to ~5000 chars, links stripped from Markdown
 * // result.links array is still populated (link extraction is independent)
 * ```
 *
 * @example Cache behavior
 * ```typescript
 * // First call: fetches from network
 * const r1 = await extractPage("https://example.com");
 * console.log(r1.fromCache); // false
 *
 * // Second call with same URL + options: served from cache
 * const r2 = await extractPage("https://example.com");
 * console.log(r2.fromCache); // true
 * console.log(r2.content === r1.content); // true
 * ```
 */
export async function extractPage(
  url: string,
  options: PipelineOptions = {},
): Promise<PageResult> {
  const resolvedOptions: Required<PipelineOptions> = {
    includeLinks: options.includeLinks !== false, // default: true
    maxLength: options.maxLength ?? 0, // 0 = no limit
  };

  // -----------------------------------------------------------------------
  // Step 1: Cache lookup
  // -----------------------------------------------------------------------
  // Check if we've already fetched this URL. The cacheManager uses URL-based
  // SHA-256 keys, so the same URL always maps to the same cache entry.
  // Note: options like maxLength/includeLinks affect post-processing only,
  // so we cache at the URL level (raw extracted content) and apply options
  // on each retrieval.
  const cached = cacheManager.getPage(url);

  if (cached) {
    // Return cached result with `fromCache: true` so the caller/LLM
    // knows the content may not be the absolute latest version.
    // Reconstruct PageResult from CachedPage.
    return {
      url,
      title: cached.title,
      content: cached.content,
      byline: cached.byline,
      excerpt: cached.excerpt,
      length: cached.length,
      links: [], // Links are not stored in page cache; re-extract if needed
      fromCache: true,
    };
  }

  // -----------------------------------------------------------------------
  // Step 2: Fetch the HTML
  // -----------------------------------------------------------------------
  // safeFetch handles: user-agent rotation, timeout, redirect following,
  // robots.txt compliance, response size limits, and error classification.
  const fetchResult = await safeFetch(url);

  // -----------------------------------------------------------------------
  // Step 3: Extract article content
  // -----------------------------------------------------------------------
  // This runs cheerio preprocessing + Readability extraction (or fallback).
  // The result contains both HTML and plain-text versions of the content.
  // We use fetchResult.url (the final URL after redirects) for accurate
  // relative URL resolution within the article content.
  const extracted = extractFromHtml(fetchResult.html, fetchResult.url);

  // -----------------------------------------------------------------------
  // Step 4: Convert to Markdown
  // -----------------------------------------------------------------------
  // Convert the extracted HTML content to clean, LLM-optimized Markdown.
  // We pass the HTML content (not textContent) because Markdown conversion
  // preserves structural elements like headings, lists, code blocks, and
  // emphasis that would be lost in plain text.
  const markdownOptions = {
    includeLinks: resolvedOptions.includeLinks,
    ...(resolvedOptions.maxLength > 0
      ? { maxLength: resolvedOptions.maxLength }
      : {}),
  };
  const markdownContent = htmlToMarkdown(extracted.content, markdownOptions);

  // -----------------------------------------------------------------------
  // Step 5: Extract links from the original HTML
  // -----------------------------------------------------------------------
  // We extract links from the RAW HTML (not the Readability output) to
  // capture all navigable links on the page, including those in nav bars
  // and sidebars that Readability may have stripped. This provides a
  // complete link topology for the crawler module.
  const links = extractLinks(fetchResult.html, fetchResult.url);

  // -----------------------------------------------------------------------
  // Step 6: Assemble the result
  // -----------------------------------------------------------------------
  const result: PageResult = {
    url,
    title: extracted.title,
    content: markdownContent,
    byline: extracted.byline,
    excerpt: extracted.excerpt,
    length: markdownContent.length,
    links,
    fromCache: false,
  };

  // -----------------------------------------------------------------------
  // Step 7: Cache the result
  // -----------------------------------------------------------------------
  // Store in cache for future requests. The cache TTL is managed by the
  // cacheManager's configuration (typically 5-15 minutes for web content).
  // We store a copy WITHOUT `fromCache: true` — the flag is set dynamically
  // when the result is retrieved from cache (see Step 1).
  cacheManager.setPage(url, {
    title: result.title,
    content: result.content,
    byline: result.byline,
    excerpt: result.excerpt,
    length: result.length,
    fetchedAt: Date.now(),
  });

  return result;
}
