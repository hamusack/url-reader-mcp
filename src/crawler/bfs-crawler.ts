/**
 * @module crawler/bfs-crawler
 * @fileoverview BFS (Breadth-First Search) crawl engine with token-based budget control.
 *
 * ## Algorithm Overview
 *
 * This module implements a classic BFS graph traversal adapted for web crawling:
 *
 * ```
 *   Start URL
 *      |
 *      v
 *   [Queue] --dequeue--> [Fetch & Extract] --enqueue new links--> [Queue]
 *      |                       |
 *      |                       v
 *      |               [Token Budget Check]
 *      |                  /          \
 *      |           under budget    over budget
 *      |                |              |
 *      |                v              v
 *      |          [Continue]      [STOP: return results]
 *      |
 *      +-- (empty) --> [STOP: no more links]
 * ```
 *
 * ## Why BFS Instead of DFS?
 * BFS guarantees that pages closer to the start URL are crawled first. This
 * is critical for crawl quality:
 *   - **Relevance**: Pages linked directly from the start URL are almost always
 *     more relevant than pages 5 links deep.
 *   - **Budget efficiency**: With a limited token budget, we want the most
 *     important pages first. BFS naturally prioritizes breadth over depth.
 *   - **Predictability**: Users can reason about crawl behavior -- "it will
 *     get all pages 1 click away before going 2 clicks deep."
 *   - **Loop safety**: BFS with a visited set naturally handles cycles in the
 *     link graph without needing explicit cycle detection.
 *
 * ## Token Budget
 * Instead of limiting by page count (which penalizes small pages and allows
 * huge pages to dominate), we use a token-based budget. This gives more
 * consistent results:
 *   - A 200-word page costs ~50 tokens
 *   - A 5000-word page costs ~1250 tokens
 *   - Budget of 100,000 tokens = roughly 5-15 pages depending on size
 *
 * The budget is checked AFTER each page is processed (not before), so the
 * final result may slightly exceed the limit by one page's worth of tokens.
 * This is intentional: it's better to include a complete page than to have
 * the crawl stop with 0 pages because the first page exceeded the budget.
 *
 * ## Error Handling Strategy
 * Individual page fetch failures are logged and skipped -- they do NOT stop
 * the entire crawl. This is essential for real-world crawling where:
 *   - Some pages return 404/500 errors
 *   - Some pages have SSL certificate issues
 *   - Some pages timeout due to slow servers
 *   - Some pages have malformed HTML that crashes the extractor
 *
 * The crawl result includes only successfully fetched pages. Failed pages
 * are silently skipped (the error is logged to stderr for debugging).
 *
 * ## Architecture Position
 * ```
 *   tools/crawl-tool  -->  bfs-crawler  (this file)
 *                              |
 *                              +-->  extractor/pipeline  (page extraction)
 *                              +-->  link-resolver       (link discovery)
 *                              +-->  token-counter       (budget tracking)
 *                              +-->  utils/url           (URL normalization)
 *                              +-->  config              (default settings)
 * ```
 *
 * @example
 * ```ts
 * import { crawl } from "./bfs-crawler.js";
 *
 * // Simple crawl with defaults
 * const result = await crawl("https://example.com/docs");
 *
 * // Crawl with custom budget and filters
 * const result = await crawl("https://example.com", {
 *   maxTokens: 50000,
 *   allowedDomains: ["example.com", "docs.example.com"],
 *   excludePatterns: ["*\/login", "*.pdf"],
 * });
 *
 * console.log(result.summary);
 * // { total_pages: 8, total_tokens: 48230, max_depth_reached: 3,
 * //   stopped_reason: "token_limit" }
 * ```
 */

import { extractPage, type PageResult } from "../extractor/pipeline.js";
import {
  extractLinks,
  filterLinks,
  type LinkFilterOptions,
} from "./link-resolver.js";
import { estimateTokens } from "./token-counter.js";
import { normalizeUrl, extractDomain } from "../utils/url.js";
import { config } from "../config.js";
import { formatErrorForMcp } from "../utils/errors.js";

/* ────────────────────────────────────────────────────────────────────────────
 * Type Definitions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Options for controlling BFS crawl behavior.
 *
 * All fields are optional -- sensible defaults are applied from the
 * application configuration ({@link config}).
 */
export interface CrawlOptions {
  /**
   * Maximum number of tokens to collect across all pages.
   *
   * The crawl stops once the cumulative token count of all successfully
   * fetched pages reaches or exceeds this value. The last page that pushes
   * the total over the limit IS included (we don't discard partial work).
   *
   * WHY tokens and not pages: Token-based budgets give more predictable
   * output sizes. A 10-page limit could yield 500 or 50,000 tokens
   * depending on page sizes. A 100,000 token limit always yields
   * approximately the same amount of content.
   *
   * @default config.defaultMaxTokens (100000)
   */
  maxTokens?: number;

  /**
   * Whitelist of domains the crawler is allowed to follow links to.
   *
   * When specified, links pointing to domains NOT in this list are skipped.
   * The start URL's domain is NOT automatically included -- you must
   * explicitly list it if you want to crawl the starting site.
   *
   * WHY not auto-include start domain: Explicit is better than implicit.
   * A user might want to start from a hub page (e.g., a link aggregator)
   * and crawl only the linked sites, not the aggregator itself.
   *
   * @example ["example.com", "docs.example.com"]
   */
  allowedDomains?: string[];

  /**
   * Glob patterns for URLs to skip during crawling.
   *
   * Matched against the full normalized URL. Any link matching at least
   * one pattern is not added to the BFS queue.
   *
   * @example ["*\/login", "*\/admin\/*", "*.pdf", "*.zip"]
   */
  excludePatterns?: string[];

  /**
   * Glob patterns for URLs to include during crawling.
   *
   * When specified, ONLY URLs matching at least one pattern are followed.
   * This is useful for scoping a crawl to a specific site section.
   *
   * @example ["*\/docs\/*", "*\/api\/*"]
   */
  includePatterns?: string[];
}

/**
 * Result for a single page within a crawl.
 *
 * Each successfully fetched page produces one of these objects. Failed
 * fetches are silently skipped and do NOT produce a CrawlPageResult.
 */
export interface CrawlPageResult {
  /**
   * The normalized URL of the page that was crawled.
   *
   * This is the URL after normalization (lowercase host, no fragments,
   * no trailing slash) -- it may differ slightly from the original href
   * that led to this page.
   *
   * @example "https://example.com/docs/getting-started"
   */
  url: string;

  /**
   * The page title extracted from the HTML `<title>` element.
   *
   * Falls back to an empty string if the page has no title. This comes
   * from the extraction pipeline's Readability processing.
   *
   * @example "Getting Started - Example Docs"
   */
  title: string;

  /**
   * The page content converted to Markdown format.
   *
   * This is the main body content after Readability processing strips
   * navigation, ads, and boilerplate. The content is in Markdown format
   * for maximum readability by LLMs.
   *
   * @example "# Getting Started\n\nWelcome to the documentation..."
   */
  content: string;

  /**
   * BFS depth of this page relative to the start URL.
   *
   * - Depth 0: The start URL itself
   * - Depth 1: Pages linked directly from the start URL
   * - Depth 2: Pages linked from depth-1 pages
   * - etc.
   *
   * This is useful for understanding how far from the starting point
   * each piece of content was found.
   *
   * @example 2
   */
  depth: number;

  /**
   * Number of outgoing links found on this page (before filtering).
   *
   * This is a raw count of all `<a href>` elements found, before
   * deduplication and filter application. Useful for understanding
   * the link density of each page.
   *
   * @example 42
   */
  links_found: number;

  /**
   * Estimated token count for this page's content.
   *
   * Calculated using the character-based heuristic from {@link estimateTokens}.
   * This is the value that contributes to the overall token budget.
   *
   * @example 1250
   */
  tokens: number;
}

/**
 * Complete result of a BFS crawl operation.
 *
 * Contains both the crawled page data and a summary of the crawl's
 * execution characteristics.
 */
export interface CrawlResult {
  /**
   * Array of successfully crawled pages, in the order they were processed.
   *
   * WHY order matters: Pages are ordered by BFS traversal order, which
   * means closer pages (lower depth) come first. This gives LLMs the
   * most relevant content at the top of the results.
   */
  pages: CrawlPageResult[];

  /**
   * Summary statistics about the crawl execution.
   *
   * These metrics help the caller understand why the crawl stopped
   * and how much of the site was covered.
   */
  summary: {
    /**
     * Total number of pages successfully crawled.
     *
     * This equals `pages.length` -- it's duplicated in the summary for
     * convenience when the caller only needs summary stats.
     */
    total_pages: number;

    /**
     * Cumulative estimated token count across all crawled pages.
     *
     * This is the sum of all `pages[i].tokens` values.
     */
    total_tokens: number;

    /**
     * Maximum BFS depth reached during the crawl.
     *
     * A value of 0 means only the start URL was crawled. A value of 3
     * means the crawler followed links up to 3 hops away from the start.
     */
    max_depth_reached: number;

    /**
     * The reason the crawl stopped.
     *
     * - `"token_limit"`: The cumulative token count reached or exceeded
     *   the configured maxTokens budget.
     * - `"no_more_links"`: The BFS queue is empty -- all discoverable
     *   pages have been visited (or filtered out).
     * - `"all_visited"`: All discovered URLs have already been visited.
     *   This is technically a subset of "no_more_links" but is
     *   distinguished for clarity.
     */
    stopped_reason: "token_limit" | "no_more_links" | "all_visited";
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Internal Types
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * An entry in the BFS queue, pairing a URL with its depth from the start.
 *
 * @internal
 */
interface QueueEntry {
  /** The normalized URL to crawl. */
  url: string;

  /**
   * Number of link-hops from the start URL.
   *
   * The start URL has depth 0, its direct links have depth 1, etc.
   */
  depth: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Main Crawl Function
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run a BFS crawl starting from the given URL, collecting pages until the
 * token budget is exhausted or no more links are available.
 *
 * ## Algorithm Steps
 * 1. Initialize the BFS queue with the start URL at depth 0.
 * 2. While the queue is not empty:
 *    a. Dequeue the next URL.
 *    b. Skip if already visited (using normalizeUrl for dedup).
 *    c. Fetch and extract the page content via `extractPage()`.
 *    d. On fetch error: log to stderr and continue to next URL.
 *    e. On success: estimate tokens, add to results.
 *    f. Check if token budget is exceeded -- if so, stop.
 *    g. Extract links from the page HTML, filter them, and enqueue
 *       unvisited links with depth + 1.
 * 3. Return all collected pages and a summary.
 *
 * ## Concurrency Model
 * This implementation is **sequential** (one page at a time). This is
 * intentional for Phase 1:
 *   - Simpler to reason about and debug
 *   - Naturally rate-limits requests
 *   - BFS ordering is preserved exactly
 *   - The upstream queue service already handles per-domain rate limiting
 *
 * Phase 2 can add parallel fetching within the same BFS level for speed,
 * but the sequential model is correct and sufficient for now.
 *
 * ## Memory Usage
 * - The `visited` Set grows with O(number of unique URLs discovered).
 *   For typical crawls (< 1000 URLs), this is negligible.
 * - The `queue` array uses shift() which is O(n) per dequeue. For crawls
 *   under ~1000 pages, this is fast enough. If we need to scale beyond
 *   that, we can switch to a proper deque data structure.
 *
 * @param startUrl - The URL to begin crawling from. Must be a valid HTTP(S)
 *   URL. This URL is always fetched first (depth 0) regardless of filters.
 * @param options - Optional crawl configuration. See {@link CrawlOptions}.
 * @returns A promise resolving to a {@link CrawlResult} containing all
 *   successfully crawled pages and summary statistics.
 *
 * @example
 * ```ts
 * // Basic crawl
 * const result = await crawl("https://example.com/docs");
 * console.log(`Crawled ${result.summary.total_pages} pages`);
 * console.log(`Used ${result.summary.total_tokens} tokens`);
 * console.log(`Stopped because: ${result.summary.stopped_reason}`);
 *
 * for (const page of result.pages) {
 *   console.log(`[depth ${page.depth}] ${page.title} (${page.tokens} tokens)`);
 * }
 * ```
 *
 * @example
 * ```ts
 * // Scoped crawl: only /docs/ section, max 50k tokens
 * const result = await crawl("https://example.com/docs", {
 *   maxTokens: 50000,
 *   includePatterns: ["*\/docs\/*"],
 *   allowedDomains: ["example.com"],
 * });
 * ```
 *
 * @example
 * ```ts
 * // Cross-domain crawl
 * const result = await crawl("https://hub.example.com", {
 *   allowedDomains: ["site-a.com", "site-b.com"],
 *   maxTokens: 200000,
 * });
 * ```
 */
export async function crawl(
  startUrl: string,
  options?: CrawlOptions,
): Promise<CrawlResult> {
  // ── Resolve options with defaults ──
  // WHY destructure with defaults: Makes the rest of the function cleaner
  // by avoiding repeated `options?.maxTokens ?? config.defaultMaxTokens`
  // checks. All optionality is resolved upfront.
  const maxTokens = options?.maxTokens ?? config.defaultMaxTokens;
  const allowedDomains = options?.allowedDomains;
  const excludePatterns = options?.excludePatterns;
  const includePatterns = options?.includePatterns;

  // Build the LinkFilterOptions for the link resolver.
  // WHY separate object: The link resolver's filter interface is different
  // from CrawlOptions. We translate between them here to keep the APIs
  // independent and reusable.
  const linkFilterOptions: LinkFilterOptions = {
    allowedDomains,
    excludePatterns,
    includePatterns,
    // WHY "all" instead of "internal": Domain filtering is handled by
    // allowedDomains. If the user didn't specify allowedDomains, we should
    // allow all domains. If they did specify it, the allowedDomains filter
    // already handles the restriction.
    filter: "all",
  };

  // ── Initialize BFS state ──

  // Normalize the start URL for consistent deduplication
  const normalizedStart = normalizeUrl(startUrl);

  // Extract the start URL's domain for link classification
  const startDomain = extractDomain(normalizedStart);

  // The BFS queue: a simple FIFO array.
  // WHY array instead of linked list: For crawls under ~1000 pages,
  // array.shift() is fast enough. The overhead of a linked-list deque
  // is not justified at this scale. If profiling shows shift() is a
  // bottleneck in Phase 2+, we can swap in a proper deque.
  const queue: QueueEntry[] = [{ url: normalizedStart, depth: 0 }];

  // Set of normalized URLs that have been visited (dequeued and processed).
  // WHY Set: O(1) lookup for "have we already visited this URL?"
  const visited = new Set<string>();

  // Accumulator for successfully crawled pages
  const pages: CrawlPageResult[] = [];

  // Running total of estimated tokens across all pages
  let totalTokens = 0;

  // Track the maximum BFS depth reached
  let maxDepthReached = 0;

  // The reason the crawl will eventually stop
  let stoppedReason: CrawlResult["summary"]["stopped_reason"] = "no_more_links";

  // ── BFS Main Loop ──
  // Continue while there are URLs in the queue.
  // The loop also exits early if the token budget is exceeded (via break).
  while (queue.length > 0) {
    // Dequeue the next URL (FIFO order = BFS).
    // WHY shift() and not pop(): shift() removes from the front, giving
    // us FIFO (queue) behavior. pop() would give LIFO (stack) behavior,
    // which is DFS -- the opposite of what we want.
    const entry = queue.shift()!;

    // Skip if we've already visited this URL.
    // WHY check here AND when enqueuing: Belt-and-suspenders defense.
    // The enqueue check prevents most duplicates, but race conditions
    // (if we ever go parallel) or edge cases in URL normalization could
    // let a duplicate slip through. Checking at dequeue is cheap insurance.
    if (visited.has(entry.url)) {
      continue;
    }

    // Mark as visited BEFORE fetching.
    // WHY before: If the fetch fails, we still don't want to retry the
    // same URL. In web crawling, a failed URL usually fails consistently
    // (404, 500, timeout). Retrying would waste time and annoy the server.
    visited.add(entry.url);

    // Update the maximum depth tracker
    if (entry.depth > maxDepthReached) {
      maxDepthReached = entry.depth;
    }

    // ── Fetch and Extract ──
    // Wrap in try/catch to handle individual page failures gracefully.
    // The crawl MUST continue even if one page fails -- this is a critical
    // design requirement for real-world crawling.
    let pageResult: PageResult;
    try {
      pageResult = await extractPage(entry.url);
    } catch (error: unknown) {
      // Log the error for debugging but don't stop the crawl.
      // WHY stderr: MCP communication uses stdout, so we must never
      // write debug output to stdout. stderr is the correct channel.
      const errorMessage = formatErrorForMcp(error);
      console.error(
        `[bfs-crawler] Failed to fetch ${entry.url}: ${errorMessage}`,
      );
      // Continue to the next URL in the queue
      continue;
    }

    // ── Token Accounting ──
    // Estimate how many tokens this page's content will consume.
    const pageTokens = estimateTokens(pageResult.content);

    // Add this page to the results.
    // WHY add before budget check: We always include the page that
    // pushes us over the budget. This prevents edge cases where:
    //   1. Budget remaining = 100 tokens
    //   2. Next page = 5000 tokens
    //   3. If we checked first, we'd skip it and potentially end with
    //      very little content. By including it, the caller gets at
    //      least one page's worth of content even if budget is tight.
    pages.push({
      url: entry.url,
      title: pageResult.title,
      content: pageResult.content,
      depth: entry.depth,
      links_found: 0, // Updated below after link extraction
      tokens: pageTokens,
    });

    totalTokens += pageTokens;

    // ── Budget Check ──
    // If we've exceeded the token budget, stop the crawl.
    if (totalTokens >= maxTokens) {
      stoppedReason = "token_limit";
      break;
    }

    // ── Link Discovery ──
    // Extract links from the fetched page and add unvisited ones to the queue.
    // WHY after budget check: If we're over budget, there's no point
    // extracting links -- we won't follow them anyway. But we do it
    // AFTER adding the page to results, so the page's content is preserved
    // even when the budget is hit.

    // We need the raw HTML to extract links. The pageResult from extractPage
    // contains the processed markdown content but we need the original HTML.
    // WHY re-check for html: The extraction pipeline may or may not expose
    // the raw HTML. If it does, we use it. If not, we skip link extraction
    // for this page (the page content is still in the results).
    let linksFound = 0;

    if (pageResult.html) {
      // Extract all links from the page HTML
      const allLinks = extractLinks(pageResult.html, entry.url);
      linksFound = allLinks.length;

      // Apply user-defined filters
      const filteredLinks = filterLinks(allLinks, startDomain, linkFilterOptions);

      // Enqueue unvisited links at the next depth level
      for (const link of filteredLinks) {
        // Skip already-visited URLs to prevent re-queuing.
        // WHY not rely on the dequeue check alone: Skipping here keeps the
        // queue smaller, which improves performance and reduces memory usage
        // on link-heavy sites.
        if (!visited.has(link.url)) {
          queue.push({ url: link.url, depth: entry.depth + 1 });
        }
      }
    }

    // Update the links_found count on the last added page.
    // WHY update after: We add the page to results before extracting links
    // (for budget-check ordering), so we update the count retroactively.
    pages[pages.length - 1].links_found = linksFound;
  }

  // ── Determine stop reason ──
  // If we didn't hit the token limit, determine why the queue emptied.
  if (stoppedReason !== "token_limit") {
    if (visited.size > 0 && queue.length === 0) {
      // WHY distinguish these two: "no_more_links" means we exhausted all
      // discoverable content. "all_visited" means we found links but they
      // all pointed to already-visited pages. In practice both mean "done",
      // but the distinction helps with debugging and user understanding.
      //
      // We check if the total pages crawled equals the visited count minus
      // any failed fetches. If pages were found but queue is empty, it's
      // because either all links led to visited pages or there were no links.
      stoppedReason = pages.length < visited.size ? "no_more_links" : "all_visited";
    }
  }

  // ── Build and return the result ──
  return {
    pages,
    summary: {
      total_pages: pages.length,
      total_tokens: totalTokens,
      max_depth_reached: maxDepthReached,
      stopped_reason: stoppedReason,
    },
  };
}
