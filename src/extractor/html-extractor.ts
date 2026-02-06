/**
 * @fileoverview HTML content extraction module for the mcp-url-reader MCP server.
 *
 * This module is responsible for extracting the main article content from raw
 * HTML pages. It implements a two-phase extraction strategy:
 *
 * **Phase 1 — Cheerio Preprocessing:**
 *   Raw HTML is loaded into cheerio (a lightweight jQuery-like library) to
 *   strip non-content elements (script, style, nav, footer, header, aside).
 *   Cheerio is ideal for this step because it is fast, doesn't execute JS,
 *   and provides a familiar CSS-selector API for surgical DOM manipulation.
 *
 * **Phase 2 — Readability Extraction:**
 *   The cleaned HTML is fed into Mozilla's Readability algorithm via JSDOM.
 *   Readability requires a full W3C DOM (document.createElement, etc.) which
 *   cheerio does not provide — that's why we need JSDOM as an intermediary.
 *   Readability applies heuristics (scoring paragraphs, detecting boilerplate)
 *   to isolate the primary article content.
 *
 * **Fallback:**
 *   If Readability returns null (e.g., the page has no identifiable article
 *   structure — think dashboards, SPAs, or heavily JS-rendered pages), we
 *   fall back to extracting the cleaned body text from the cheerio-processed
 *   HTML. This ensures we always return *something* useful to the caller.
 *
 * @module extractor/html-extractor
 */

import * as cheerio from "cheerio";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Represents the structured content extracted from an HTML page.
 *
 * This interface is the primary output of the extraction pipeline and is
 * consumed by downstream modules (markdown-converter, pipeline) to produce
 * the final user-facing result.
 *
 * @example
 * ```typescript
 * const result = extractFromHtml(rawHtml, "https://example.com/article");
 * console.log(result.title);       // "How to Build an MCP Server"
 * console.log(result.textContent);  // Plain-text article body
 * console.log(result.length);       // 4823  (character count)
 * ```
 */
export interface ExtractedContent {
  /** The article title, extracted by Readability or from the <title> tag. */
  title: string;

  /**
   * The article body as an HTML fragment.
   *
   * This is the *cleaned* HTML produced by Readability — it contains only
   * content-relevant tags (p, h1-h6, img, a, ul, ol, li, blockquote, etc.)
   * with all boilerplate removed. Downstream converters (e.g., Turndown)
   * can transform this into Markdown or plain text.
   */
  content: string;

  /**
   * The article body as plain text (no HTML tags).
   *
   * Useful for quick previews, token counting, and scenarios where
   * Markdown conversion is unnecessary.
   */
  textContent: string;

  /** The author or byline, if Readability could detect one. */
  byline?: string;

  /** A short excerpt / summary of the article. */
  excerpt?: string;

  /** The site name (e.g., "Medium", "The New York Times"). */
  siteName?: string;

  /**
   * Character count of the plain-text content.
   *
   * Used by the pipeline to decide whether truncation is needed and by
   * the token counter to estimate LLM token usage.
   */
  length: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * CSS selectors for elements that should be removed during preprocessing.
 *
 * **Why these specific tags?**
 * - `script` / `noscript`: Executable code and fallback content — never useful
 *   as article text, and can confuse Readability's scoring heuristics.
 * - `style`: CSS rules are noise for content extraction.
 * - `nav`: Navigation menus are boilerplate repeated across every page.
 * - `footer` / `header`: Typically contain site-wide chrome (logos, copyright,
 *   social links) rather than article content.
 * - `aside`: Sidebars, related-article widgets, ad containers.
 * - `iframe`: Embedded third-party content (ads, videos) that won't render
 *   in a text-extraction context anyway.
 * - `[role="navigation"]` / `[role="banner"]` / `[role="contentinfo"]`:
 *   ARIA landmarks that semantically mark non-content regions.
 *
 * We intentionally do NOT remove `<form>` or `<table>` because some articles
 * legitimately contain data tables and interactive examples.
 */
const NOISE_SELECTORS: readonly string[] = [
  "script",
  "noscript",
  "style",
  "nav",
  "footer",
  "header",
  "aside",
  "iframe",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
] as const;

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Preprocess raw HTML by removing non-content elements with cheerio.
 *
 * This is the first phase of extraction. By stripping boilerplate *before*
 * handing the HTML to Readability, we:
 *   1. Reduce JSDOM parse time (less DOM surface area).
 *   2. Improve Readability's accuracy (fewer noise nodes to score).
 *   3. Eliminate edge cases where nav/footer text leaks into the article.
 *
 * @param html - The raw HTML string from the HTTP response.
 * @returns The cleaned HTML string with noise elements removed.
 *
 * @example
 * ```typescript
 * const cleaned = preprocessHtml('<html><nav>Menu</nav><p>Article</p></html>');
 * // cleaned: '<html><p>Article</p></html>'
 * ```
 */
function preprocessHtml(html: string): string {
  // Load into cheerio. The `decodeEntities: false` option preserves the
  // original encoding of HTML entities (e.g., &amp;) so that downstream
  // consumers (JSDOM, Turndown) receive correctly-encoded HTML.
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove each noise element. We iterate over NOISE_SELECTORS rather than
  // building a single mega-selector ("script, style, nav, ...") for two
  // reasons:
  //   1. Readability and debuggability — each removal is a discrete step.
  //   2. Future extensibility — individual selectors can be toggled via config.
  for (const selector of NOISE_SELECTORS) {
    $(selector).remove();
  }

  // Also strip HTML comments, which often contain ad-server markers,
  // conditional IE directives, or template-engine artifacts that pollute
  // Readability's content scoring.
  $("*")
    .contents()
    .filter(function (this: cheerio.AnyNode) {
      // nodeType 8 === Comment node in the DOM spec.
      return this.type === "comment";
    })
    .remove();

  return $.html();
}

/**
 * Extract a page title from HTML using cheerio as a fallback mechanism.
 *
 * Readability normally handles title extraction, but when it returns null
 * (fallback path), we need our own title extractor. We try multiple
 * sources in priority order:
 *   1. `<meta property="og:title">` — Open Graph title, usually the most
 *      human-readable and curated title.
 *   2. `<title>` tag — The document title, though it often contains the
 *      site name appended (e.g., "Article | SiteName").
 *   3. First `<h1>` tag — A reasonable heuristic for the main heading.
 *   4. Empty string — Absolute last resort.
 *
 * @param $ - A loaded cheerio instance.
 * @returns The best-guess page title.
 */
function extractFallbackTitle($: cheerio.CheerioAPI): string {
  // Priority 1: Open Graph title — most reliable for social/sharing contexts.
  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle?.trim()) {
    return ogTitle.trim();
  }

  // Priority 2: Standard <title> tag.
  const titleTag = $("title").text();
  if (titleTag?.trim()) {
    return titleTag.trim();
  }

  // Priority 3: First <h1> on the page.
  const h1 = $("h1").first().text();
  if (h1?.trim()) {
    return h1.trim();
  }

  // Priority 4: Give up — return empty string.
  return "";
}

/**
 * Extract the body text from cheerio-cleaned HTML as a fallback.
 *
 * When Readability can't identify an article (returns null), we still want
 * to return *something* useful. This function extracts all visible text
 * from the `<body>` element, normalizing whitespace so the output is
 * clean and readable.
 *
 * @param $ - A loaded cheerio instance with noise elements already removed.
 * @returns The visible body text, with normalized whitespace.
 */
function extractFallbackBodyText($: cheerio.CheerioAPI): string {
  const bodyText = $("body").text();

  // Normalize whitespace: collapse multiple spaces/tabs/newlines into
  // single spaces, then trim leading/trailing whitespace. This produces
  // a clean, single-paragraph-like string that is still useful for LLMs.
  return bodyText.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the main article content from a raw HTML string.
 *
 * This is the primary entry point for content extraction. It implements
 * the two-phase strategy described in the module-level documentation:
 * cheerio preprocessing followed by Readability extraction, with a
 * cheerio-based fallback if Readability can't identify an article.
 *
 * **Performance notes:**
 * - JSDOM instantiation is the most expensive step (~5-20ms depending on
 *   HTML size). The cheerio preprocessing step mitigates this by reducing
 *   the HTML size before JSDOM processes it.
 * - For very large pages (>1MB), callers should consider truncating the
 *   raw HTML before calling this function.
 *
 * @param html - The raw HTML string to extract content from.
 * @param url  - The original URL of the page. Required by Readability to
 *               resolve relative URLs within the article content and to
 *               apply site-specific heuristics.
 * @returns An {@link ExtractedContent} object containing the article's
 *          title, HTML content, plain text, and metadata.
 *
 * @example
 * ```typescript
 * import { extractFromHtml } from "./html-extractor.js";
 *
 * const html = await fetch("https://example.com/blog/post").then(r => r.text());
 * const result = extractFromHtml(html, "https://example.com/blog/post");
 *
 * console.log(result.title);       // "My Blog Post"
 * console.log(result.textContent);  // "This is the article body..."
 * console.log(result.byline);       // "John Doe"
 * console.log(result.length);       // 2847
 * ```
 *
 * @example Handling fallback (non-article pages)
 * ```typescript
 * // Dashboard pages, SPAs, etc. will still return content
 * const result = extractFromHtml(dashboardHtml, "https://app.example.com");
 * // result.content will contain the cleaned body text (no Readability markup)
 * // result.excerpt will be undefined
 * ```
 */
export function extractFromHtml(html: string, url: string): ExtractedContent {
  // -----------------------------------------------------------------------
  // Phase 1: Cheerio preprocessing
  // -----------------------------------------------------------------------
  // Strip out navigation, scripts, styles, and other boilerplate elements
  // so that Readability receives a cleaner signal for article detection.
  const cleanedHtml = preprocessHtml(html);

  // -----------------------------------------------------------------------
  // Phase 2: Readability extraction via JSDOM
  // -----------------------------------------------------------------------
  // JSDOM creates a full W3C-compliant DOM from the cleaned HTML.
  // We pass the original URL so that Readability can:
  //   - Resolve relative URLs (images, links) within the article.
  //   - Apply any URL-pattern-based heuristics it may have.
  const dom = new JSDOM(cleanedHtml, { url });

  try {
    const document = dom.window.document;

    // Readability.parse() returns null when it cannot identify an article
    // structure in the page. This commonly happens with:
    //   - Single-page applications (content loaded via JS)
    //   - Dashboard / admin pages
    //   - Pages with very little text content
    //   - Pages where all content is in lists/tables without paragraphs
    const reader = new Readability(document);
    const article = reader.parse();

    if (article) {
      // ----- Success path: Readability found an article -----
      return {
        title: article.title || "",
        content: article.content || "",
        textContent: article.textContent || "",
        byline: article.byline || undefined,
        excerpt: article.excerpt || undefined,
        siteName: article.siteName || undefined,
        length: (article.textContent || "").length,
      };
    }
  } finally {
    // Always close the JSDOM window to release resources and prevent
    // memory leaks. JSDOM retains internal references that can prevent
    // garbage collection if not explicitly closed.
    dom.window.close();
  }

  // -----------------------------------------------------------------------
  // Fallback path: Readability returned null
  // -----------------------------------------------------------------------
  // Re-load the cleaned HTML into cheerio to extract what we can.
  // We prefer cheerio over JSDOM here because we only need text extraction,
  // and cheerio is significantly lighter for that purpose.
  const $ = cheerio.load(cleanedHtml, { decodeEntities: false });
  const fallbackTitle = extractFallbackTitle($);
  const fallbackText = extractFallbackBodyText($);

  // Wrap the fallback text in a <p> tag so downstream HTML-to-Markdown
  // converters treat it as a proper paragraph rather than raw text.
  const fallbackHtml = `<p>${escapeHtmlEntities(fallbackText)}</p>`;

  return {
    title: fallbackTitle,
    content: fallbackHtml,
    textContent: fallbackText,
    byline: undefined,
    excerpt: undefined,
    siteName: undefined,
    length: fallbackText.length,
  };
}

/**
 * Escape basic HTML entities in a plain-text string.
 *
 * Used when wrapping fallback body text in an HTML `<p>` tag to prevent
 * any stray `<`, `>`, or `&` characters in the text from being
 * misinterpreted as HTML markup by downstream consumers.
 *
 * @param text - The plain-text string to escape.
 * @returns The escaped string, safe for embedding in HTML.
 *
 * @example
 * ```typescript
 * escapeHtmlEntities('Tom & Jerry <3 cheese');
 * // Returns: 'Tom &amp; Jerry &lt;3 cheese'
 * ```
 */
function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
