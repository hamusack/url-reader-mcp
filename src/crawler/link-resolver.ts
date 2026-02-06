/**
 * @module crawler/link-resolver
 * @fileoverview Link extraction, normalization, and filtering for web crawling.
 *
 * This module is responsible for the "discovery" phase of BFS crawling:
 * given an HTML page, it finds all outgoing links, resolves them to absolute
 * URLs, deduplicates them, and applies user-defined filters to decide which
 * links the crawler should follow.
 *
 * ## Design Decisions
 *
 * ### Why cheerio instead of regex?
 * HTML is not a regular language -- parsing `<a href="...">` with regex is
 * fragile and fails on edge cases like quoted attributes, nested tags, and
 * malformed HTML. cheerio provides a proper DOM parser (htmlparser2 under
 * the hood) that handles real-world HTML robustly.
 *
 * ### Why not jsdom for link extraction?
 * We already use jsdom in the extraction pipeline for Readability processing,
 * but jsdom is ~10x slower than cheerio for simple DOM queries. Since link
 * extraction only needs to find `<a>` elements and read their `href`, cheerio
 * is the right tool: fast, lightweight, and purpose-built for this kind of
 * scraping.
 *
 * ### URL Normalization
 * We normalize URLs before deduplication to prevent the crawler from visiting
 * the same page twice under different representations:
 *   - `https://example.com/page` vs `https://example.com/page/`
 *   - `https://example.com/page#section` vs `https://example.com/page`
 *   - `https://example.com/page?` vs `https://example.com/page`
 *
 * ### Internal vs External Classification
 * A link is "internal" if its domain matches the base URL's domain. This is
 * used by the BFS crawler to implement same-domain crawling by default,
 * while still allowing users to explicitly include external domains.
 *
 * ## Architecture Position
 * ```
 *   bfs-crawler  -->  link-resolver  (this file)
 *        |                |
 *        |                +-->  utils/url  (normalizeUrl, resolveUrl, etc.)
 *        |
 *        +-->  token-counter
 *        +-->  extractor/pipeline
 * ```
 *
 * @example
 * ```ts
 * import { extractLinks, filterLinks } from "./link-resolver.js";
 *
 * const html = '<html><body><a href="/about">About</a></body></html>';
 * const links = extractLinks(html, "https://example.com");
 * // => [{ text: "About", url: "https://example.com/about", isInternal: true }]
 *
 * const filtered = filterLinks(links, "example.com", {
 *   excludePatterns: ["*\/admin\/*"],
 * });
 * ```
 */

import * as cheerio from "cheerio";
import {
  normalizeUrl,
  resolveUrl,
  extractDomain,
  matchesPattern,
  isFetchableUrl,
} from "../utils/url.js";

/* ────────────────────────────────────────────────────────────────────────────
 * Type Definitions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Options for controlling which links are kept after extraction.
 *
 * All fields are optional -- omitting a field means no filtering is applied
 * for that dimension. Filters are applied in conjunction (AND logic):
 * a link must pass ALL active filters to be included in the result.
 */
export interface LinkFilterOptions {
  /**
   * Whitelist of domains whose links should be followed.
   *
   * When specified, only links pointing to one of these domains are kept.
   * Domain matching is case-insensitive and does NOT include subdomains
   * automatically -- `"example.com"` will NOT match `"sub.example.com"`.
   *
   * WHY explicit domains: This prevents the crawler from accidentally
   * wandering off to CDN domains, ad networks, or unrelated sites linked
   * from the page.
   *
   * @example ["example.com", "docs.example.com"]
   */
  allowedDomains?: string[];

  /**
   * Glob patterns for URLs to exclude.
   *
   * Any link whose normalized URL matches at least one of these patterns
   * is removed from the result. Useful for skipping login pages, admin
   * areas, or file downloads.
   *
   * Pattern syntax follows shell glob conventions:
   *   - `*` matches any sequence of characters within a path segment
   *   - `**` matches across path segments
   *   - `?` matches a single character
   *
   * @example ["*\/login", "*\/admin\/*", "*.pdf"]
   */
  excludePatterns?: string[];

  /**
   * Glob patterns for URLs to include.
   *
   * When specified, ONLY links matching at least one pattern are kept.
   * This is useful for scoping a crawl to a specific section of a site.
   *
   * WHY include AND exclude: They serve different purposes. `include` is
   * a whitelist ("only crawl these paths"), while `exclude` is a blacklist
   * ("skip these specific paths"). When both are set, a URL must match
   * at least one include pattern AND not match any exclude pattern.
   *
   * @example ["*\/docs\/*", "*\/blog\/*"]
   */
  includePatterns?: string[];

  /**
   * Filter links by their relationship to the starting URL's domain.
   *
   * - `"internal"`: Keep only links on the same domain as the base URL.
   * - `"external"`: Keep only links to different domains.
   * - `"all"`: Keep all links regardless of domain.
   *
   * WHY default to "all" and not "internal": The BFS crawler already
   * defaults to same-domain crawling via its own logic. The link resolver
   * should be a neutral filter that doesn't impose crawl policy -- that's
   * the crawler's job.
   *
   * @default "all"
   */
  filter?: "internal" | "external" | "all";
}

/**
 * A fully resolved, normalized link extracted from an HTML page.
 *
 * All URLs are absolute -- relative URLs have been resolved against the
 * base URL of the page they were found on.
 */
export interface ResolvedLink {
  /**
   * The visible text content of the anchor element.
   *
   * This is extracted via cheerio's `.text()` which strips all HTML tags
   * and returns concatenated text nodes. The text is trimmed of leading
   * and trailing whitespace.
   *
   * Empty-text links (e.g., image-only links) will have `text` set to
   * an empty string `""`. We preserve these because they may still be
   * valid navigation targets.
   *
   * @example "About Us"
   * @example "" (for <a href="/page"><img src="..." /></a>)
   */
  text: string;

  /**
   * The fully resolved and normalized absolute URL.
   *
   * Normalization includes:
   * - Resolving relative paths against the base URL
   * - Removing fragment identifiers (#...)
   * - Removing trailing slashes for consistency
   * - Lowercasing the scheme and hostname
   *
   * @example "https://example.com/about"
   */
  url: string;

  /**
   * Whether this link points to the same domain as the page it was found on.
   *
   * Domain comparison is performed on the extracted hostname (excluding port)
   * and is case-insensitive.
   *
   * @example true  // for href="/about" on https://example.com
   * @example false // for href="https://other.com/page"
   */
  isInternal: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Non-Fetchable Scheme Filtering
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Set of URL schemes that should never be followed by the crawler.
 *
 * WHY a Set: O(1) lookup is important here because we check every single
 * link on every page. A Set is faster than an array `.includes()` for
 * the number of entries we have (7+).
 *
 * @internal
 */
const NON_FETCHABLE_SCHEMES = new Set([
  "javascript:",
  "mailto:",
  "tel:",
  "data:",
  "blob:",
  "ftp:",
  "file:",
]);

/**
 * Check if a raw href string starts with a non-fetchable scheme.
 *
 * We check the raw href (before URL resolution) because URL constructors
 * may throw on schemes like `javascript:void(0)`.
 *
 * @param href - The raw href attribute value from an anchor element.
 * @returns `true` if the href starts with a non-fetchable scheme.
 *
 * @example
 * ```ts
 * hasNonFetchableScheme("javascript:void(0)"); // true
 * hasNonFetchableScheme("mailto:user@example.com"); // true
 * hasNonFetchableScheme("/about"); // false
 * hasNonFetchableScheme("https://example.com"); // false
 * ```
 *
 * @internal
 */
function hasNonFetchableScheme(href: string): boolean {
  // WHY toLowerCase: Schemes are case-insensitive per RFC 3986, so
  // "MAILTO:" and "mailto:" should be treated identically.
  const lower = href.trim().toLowerCase();

  for (const scheme of NON_FETCHABLE_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return true;
    }
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Link Extraction
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Extract and resolve all links from an HTML document.
 *
 * This function performs the following pipeline:
 *   1. Parse the HTML with cheerio (htmlparser2 under the hood)
 *   2. Find all `<a>` elements with an `href` attribute
 *   3. Skip links with non-fetchable schemes (javascript:, mailto:, etc.)
 *   4. Resolve relative URLs to absolute using the provided base URL
 *   5. Normalize URLs for deduplication (lowercase host, strip fragments)
 *   6. Deduplicate by normalized URL (first occurrence wins)
 *   7. Classify each link as internal or external
 *   8. Optionally apply filters (domain, include/exclude patterns)
 *
 * **Performance:** For a typical web page with 50-200 links, this function
 * completes in <5ms. The main cost is cheerio's HTML parsing, which is
 * already highly optimized.
 *
 * **Edge cases handled:**
 * - Empty href attributes are skipped
 * - Href values that are just "#" (fragment-only) are skipped
 * - Malformed URLs that throw in the URL constructor are skipped
 * - Links inside `<nav>`, `<footer>`, `<header>` are all included
 *   (the BFS crawler doesn't need to distinguish navigation structure)
 *
 * @param html - The raw HTML string of the page to extract links from.
 * @param baseUrl - The URL of the page, used for resolving relative hrefs
 *   and determining internal/external classification.
 * @param options - Optional filters to apply to extracted links. If omitted,
 *   all fetchable links are returned without filtering.
 * @returns An array of {@link ResolvedLink} objects, deduplicated by URL.
 *   The order follows document order (top-to-bottom as they appear in HTML).
 *
 * @example
 * ```ts
 * const html = `
 *   <html><body>
 *     <a href="/about">About</a>
 *     <a href="https://other.com">External</a>
 *     <a href="javascript:void(0)">Skip me</a>
 *     <a href="/about">Duplicate</a>
 *   </body></html>
 * `;
 *
 * const links = extractLinks(html, "https://example.com");
 * // Result:
 * // [
 * //   { text: "About", url: "https://example.com/about", isInternal: true },
 * //   { text: "External", url: "https://other.com", isInternal: false },
 * // ]
 * // Note: "javascript:" link is skipped, duplicate "/about" is deduplicated
 * ```
 *
 * @example
 * ```ts
 * // With filtering:
 * const links = extractLinks(html, "https://example.com", {
 *   filter: "internal",
 *   excludePatterns: ["*\/admin\/*"],
 * });
 * ```
 */
export function extractLinks(
  html: string,
  baseUrl: string,
  options?: LinkFilterOptions,
): ResolvedLink[] {
  // Load the HTML into cheerio's DOM.
  // WHY not pass decoding options: cheerio auto-detects encoding, and
  // we've already fetched the HTML with proper encoding handling upstream.
  const $ = cheerio.load(html);

  // Extract the base page's domain for internal/external classification.
  const baseDomain = extractDomain(baseUrl);

  // Set to track normalized URLs we've already seen, for deduplication.
  // WHY a Set and not filtering after: Early deduplication saves memory
  // and avoids building a large intermediate array on link-heavy pages.
  const seen = new Set<string>();

  // Accumulator for the deduplicated results
  const links: ResolvedLink[] = [];

  // Iterate over every <a> element that has an href attribute.
  // WHY "a[href]" selector: This skips anchor elements without href
  // (e.g., `<a name="section">`) which are not navigable links.
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");

    // Guard: skip empty or whitespace-only hrefs
    if (!href || href.trim().length === 0) {
      return; // cheerio's .each() treats `return` like `continue`
    }

    const trimmedHref = href.trim();

    // Skip fragment-only links (e.g., "#top", "#section-3")
    // WHY: These point to the same page and would create self-loops in
    // the BFS queue. They're useless for crawling.
    if (trimmedHref.startsWith("#")) {
      return;
    }

    // Skip non-fetchable schemes before attempting URL resolution.
    // WHY before resolution: The URL constructor may throw on schemes
    // like `javascript:` with complex expressions, so we filter early.
    if (hasNonFetchableScheme(trimmedHref)) {
      return;
    }

    // Attempt to resolve the relative URL to an absolute URL.
    // WHY try/catch: Malformed hrefs can cause the URL constructor to
    // throw. In the wild, we see hrefs like `://broken`, `http://`,
    // and other garbage. We skip these silently rather than crashing.
    let absoluteUrl: string;
    try {
      absoluteUrl = resolveUrl(baseUrl, trimmedHref);
    } catch {
      // Malformed URL -- skip silently. This is expected for broken HTML.
      return;
    }

    // Normalize the URL for consistent deduplication.
    // This strips fragments, trailing slashes, and lowercases the host.
    const normalized = normalizeUrl(absoluteUrl);

    // Skip if we've already seen this normalized URL
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);

    // Perform a final fetchability check on the resolved URL.
    // WHY: resolveUrl might produce a valid-looking URL from a relative
    // path that still isn't fetchable (e.g., if the base URL itself is
    // malformed). isFetchableUrl checks for http/https scheme.
    if (!isFetchableUrl(normalized)) {
      return;
    }

    // Extract the link text, trimmed of whitespace.
    // WHY .text() instead of .html(): We want the human-readable text,
    // not any nested HTML. Image alt text is NOT captured by .text() --
    // this is an acceptable trade-off for simplicity.
    const text = $(element).text().trim();

    // Classify as internal or external based on domain comparison.
    const linkDomain = extractDomain(normalized);
    const isInternal = linkDomain === baseDomain;

    links.push({ text, url: normalized, isInternal });
  });

  // Apply optional filters if provided
  if (options) {
    return filterLinks(links, baseDomain, options);
  }

  return links;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Link Filtering
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Apply filters to an array of already-extracted links.
 *
 * This function is separated from {@link extractLinks} to allow re-filtering
 * the same set of links with different options without re-parsing the HTML.
 * This is useful when the BFS crawler adjusts its strategy mid-crawl.
 *
 * **Filter application order:**
 *   1. Internal/external filter (`options.filter`)
 *   2. Allowed domains filter (`options.allowedDomains`)
 *   3. Include patterns filter (`options.includePatterns`)
 *   4. Exclude patterns filter (`options.excludePatterns`)
 *
 * The order matters: we apply cheap checks first (boolean comparison for
 * internal/external) and expensive checks later (glob pattern matching).
 * This short-circuits early for links that fail cheap filters.
 *
 * @param links - Array of resolved links to filter. Not mutated.
 * @param baseDomain - The domain of the page the links were extracted from.
 *   Used for the internal/external filter classification. Should be
 *   lowercase and without port number.
 * @param options - Filter options to apply. See {@link LinkFilterOptions}
 *   for detailed documentation of each filter.
 * @returns A new array containing only the links that pass all filters.
 *   Original order is preserved.
 *
 * @example
 * ```ts
 * const links: ResolvedLink[] = [
 *   { text: "Home", url: "https://example.com", isInternal: true },
 *   { text: "Blog", url: "https://example.com/blog", isInternal: true },
 *   { text: "Admin", url: "https://example.com/admin/panel", isInternal: true },
 *   { text: "Other", url: "https://other.com", isInternal: false },
 * ];
 *
 * // Keep only internal links, exclude admin pages
 * filterLinks(links, "example.com", {
 *   filter: "internal",
 *   excludePatterns: ["*\/admin\/*"],
 * });
 * // => [
 * //   { text: "Home", url: "https://example.com", isInternal: true },
 * //   { text: "Blog", url: "https://example.com/blog", isInternal: true },
 * // ]
 * ```
 *
 * @example
 * ```ts
 * // Scope to docs section only
 * filterLinks(links, "example.com", {
 *   includePatterns: ["*\/docs\/*"],
 * });
 * ```
 */
export function filterLinks(
  links: ResolvedLink[],
  baseDomain: string,
  options: LinkFilterOptions,
): ResolvedLink[] {
  return links.filter((link) => {
    // ── Filter 1: Internal/External classification ──
    // This is the cheapest check (boolean comparison), so it goes first.
    if (options.filter === "internal" && !link.isInternal) {
      return false;
    }
    if (options.filter === "external" && link.isInternal) {
      return false;
    }

    // ── Filter 2: Allowed domains whitelist ──
    // WHY check domain instead of origin: We want to ignore port differences
    // (e.g., https://example.com vs https://example.com:443 should match).
    if (options.allowedDomains && options.allowedDomains.length > 0) {
      const linkDomain = extractDomain(link.url);
      // Case-insensitive comparison. The allowedDomains array may contain
      // mixed-case entries from user input.
      const isAllowed = options.allowedDomains.some(
        (domain) => domain.toLowerCase() === linkDomain.toLowerCase(),
      );
      if (!isAllowed) {
        return false;
      }
    }

    // ── Filter 3: Include patterns (whitelist) ──
    // When include patterns are specified, the link MUST match at least one.
    // WHY "at least one" (OR logic): Include patterns represent different
    // sections the user wants to crawl. A URL in the /docs/ section OR
    // the /blog/ section should be included.
    if (options.includePatterns && options.includePatterns.length > 0) {
      const matchesAny = options.includePatterns.some((pattern) =>
        matchesPattern(link.url, pattern),
      );
      if (!matchesAny) {
        return false;
      }
    }

    // ── Filter 4: Exclude patterns (blacklist) ──
    // If the link matches ANY exclude pattern, it is removed.
    // WHY "any" (OR logic): Exclude patterns represent different categories
    // of unwanted content. If a URL matches any blacklist, it should be
    // excluded regardless of whether it also matches an include pattern.
    // This is intentional: exclude takes precedence over include.
    if (options.excludePatterns && options.excludePatterns.length > 0) {
      const matchesAny = options.excludePatterns.some((pattern) =>
        matchesPattern(link.url, pattern),
      );
      if (matchesAny) {
        return false;
      }
    }

    // Link passed all filters
    return true;
  });
}
