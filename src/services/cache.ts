/**
 * @fileoverview In-memory TTL cache service for the mcp-url-reader MCP server.
 *
 * This module provides a two-namespace caching layer that stores fetched page
 * content and extracted link lists separately. It wraps the `node-cache` library
 * with SHA-256 URL hashing, configurable TTL, and built-in hit/miss statistics.
 *
 * ## Architecture Decisions
 *
 * **Why two namespaces?**
 * Page content (Markdown) and link lists have very different access patterns.
 * A tool call to `read_url` only needs the page cache, while `get_links` only
 * needs the links cache. Separating them avoids unnecessary evictions when one
 * namespace is accessed far more frequently than the other.
 *
 * **Why SHA-256 for cache keys?**
 * URLs can be arbitrarily long and contain characters that are awkward in key
 * strings (query params, fragments, encoded characters). A fixed-length hex
 * hash produces a clean, constant-size key without collision risk for practical
 * purposes (SHA-256 has 2^256 possible outputs).
 *
 * **Why a singleton?**
 * The cache must be shared across all MCP tool handlers and the fetch service.
 * A singleton guarantees exactly one cache instance exists for the process
 * lifetime, preventing duplication and inconsistent state.
 *
 * @module services/cache
 */

import crypto from "node:crypto";
import NodeCache from "node-cache";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Represents a cached page that was fetched and converted to Markdown.
 *
 * @example
 * ```typescript
 * const page: CachedPage = {
 *   title: "Example Domain",
 *   content: "# Example Domain\n\nThis domain is for ...",
 *   byline: "IANA",
 *   excerpt: "This domain is established to be used for illustrative examples.",
 *   length: 1256,
 *   fetchedAt: Date.now(),
 * };
 * ```
 */
export interface CachedPage {
  /** The page title extracted by Readability or from <title> tag. */
  title: string;

  /** The full page content converted to Markdown format. */
  content: string;

  /**
   * Author or byline information, if available.
   * This is extracted by Mozilla Readability and may not be present on all pages.
   */
  byline?: string;

  /**
   * A short excerpt or description of the page content.
   * Typically the first paragraph or the meta description.
   */
  excerpt?: string;

  /** The character length of the original HTML before Markdown conversion. */
  length: number;

  /**
   * Timestamp (milliseconds since epoch) when the page was fetched.
   * Used to determine freshness and display "fetched X seconds ago" info.
   */
  fetchedAt: number;
}

/**
 * Represents a cached list of links extracted from a page.
 *
 * @example
 * ```typescript
 * const links: CachedLinks = {
 *   links: [
 *     { text: "About Us", url: "https://example.com/about" },
 *     { text: "Contact", url: "https://example.com/contact" },
 *   ],
 *   fetchedAt: Date.now(),
 * };
 * ```
 */
export interface CachedLinks {
  /** Array of link objects extracted from the page. */
  links: Array<{
    /** The visible anchor text of the link. */
    text: string;
    /** The fully resolved absolute URL of the link. */
    url: string;
  }>;

  /**
   * Timestamp (milliseconds since epoch) when the links were fetched.
   * Used to determine freshness of the link data.
   */
  fetchedAt: number;
}

/**
 * Cache hit/miss statistics for monitoring and debugging.
 *
 * @example
 * ```typescript
 * const stats = cacheManager.getStats();
 * console.log(`Hit rate: ${stats.hitRate.toFixed(2)}%`);
 * // => "Hit rate: 78.43%"
 * ```
 */
export interface CacheStats {
  /** Total number of cache lookup attempts (hits + misses). */
  totalRequests: number;

  /** Number of times a requested key was found in cache. */
  hits: number;

  /** Number of times a requested key was NOT found in cache. */
  misses: number;

  /**
   * Hit rate as a percentage (0-100).
   * Returns 0 if no requests have been made to avoid division by zero.
   */
  hitRate: number;

  /** Number of entries currently stored in the page cache namespace. */
  pageEntries: number;

  /** Number of entries currently stored in the links cache namespace. */
  linkEntries: number;

  /** Total number of entries across both namespaces. */
  totalEntries: number;
}

// ---------------------------------------------------------------------------
// Cache Key Prefixes
// ---------------------------------------------------------------------------

/**
 * Namespace prefix for page content cache entries.
 *
 * Using a prefix ensures that even if the same URL hash exists in both
 * the page and links cache, the keys will never collide within the
 * underlying NodeCache storage.
 */
const PAGE_PREFIX = "page:" as const;

/**
 * Namespace prefix for link list cache entries.
 */
const LINKS_PREFIX = "links:" as const;

// ---------------------------------------------------------------------------
// CacheManager Class
// ---------------------------------------------------------------------------

/**
 * Manages an in-memory TTL cache with two logical namespaces: pages and links.
 *
 * The CacheManager wraps `node-cache` to provide:
 * - Automatic SHA-256 hashing of URL keys
 * - Separate get/set methods for page content vs. link lists
 * - Built-in hit/miss statistics tracking
 * - Configurable TTL and maximum key limits
 *
 * ## Usage
 *
 * ```typescript
 * import { cacheManager } from "./services/cache.js";
 *
 * // Store a page
 * cacheManager.setPage("https://example.com", {
 *   title: "Example",
 *   content: "# Example\n\nHello world",
 *   length: 42,
 *   fetchedAt: Date.now(),
 * });
 *
 * // Retrieve a page (returns undefined on miss)
 * const page = cacheManager.getPage("https://example.com");
 *
 * // Check stats
 * const stats = cacheManager.getStats();
 * console.log(`Cache hit rate: ${stats.hitRate}%`);
 * ```
 *
 * @remarks
 * This class is NOT meant to be instantiated directly. Use the exported
 * `cacheManager` singleton instead.
 */
class CacheManager {
  /**
   * The underlying node-cache instance that stores all cached data.
   *
   * We use a single NodeCache instance for both namespaces (pages and links)
   * because node-cache handles TTL per-key and we differentiate entries via
   * key prefixes. This avoids the overhead of maintaining two separate
   * NodeCache instances with their own timer intervals.
   */
  private cache: NodeCache;

  /**
   * Running count of cache hits across all namespaces.
   * Incremented every time getPage() or getLinks() finds a cached entry.
   */
  private hitCount: number = 0;

  /**
   * Running count of cache misses across all namespaces.
   * Incremented every time getPage() or getLinks() returns undefined.
   */
  private missCount: number = 0;

  /**
   * Creates a new CacheManager instance.
   *
   * @param ttlSeconds - Time-to-live for cache entries in seconds.
   *   After this duration, entries are automatically evicted by node-cache.
   *   Defaults to `config.cacheTtl` (typically 3600 = 1 hour).
   *
   * @param maxKeys - Maximum number of keys allowed in the cache.
   *   When this limit is reached, node-cache will throw on set operations.
   *   Defaults to `config.cacheMaxKeys` (typically 500).
   *   Note: This limit applies across BOTH namespaces combined.
   *
   * @example
   * ```typescript
   * // Typically you don't construct this directly; use the singleton.
   * // But for testing:
   * const testCache = new CacheManager(60, 10);
   * ```
   */
  constructor(ttlSeconds?: number, maxKeys?: number) {
    const ttl = ttlSeconds ?? config.cacheTtl;
    const max = maxKeys ?? config.cacheMaxKeys;

    this.cache = new NodeCache({
      // stdTTL: default TTL applied to every set() call unless overridden
      stdTTL: ttl,

      // checkperiod: how often (in seconds) node-cache scans for expired keys.
      // We set this to 20% of TTL as a reasonable balance between memory
      // reclamation speed and CPU overhead from periodic scanning.
      checkperiod: Math.max(60, Math.floor(ttl * 0.2)),

      // maxKeys: hard limit on total stored keys (0 = unlimited).
      // This prevents unbounded memory growth if the server is hammered
      // with unique URLs.
      maxKeys: max,

      // useClones: false for performance. We trust callers not to mutate
      // returned objects. Since our cached data is effectively read-only
      // (we never modify a CachedPage after creation), cloning is wasteful.
      useClones: false,
    });
  }

  // -------------------------------------------------------------------------
  // URL Hashing
  // -------------------------------------------------------------------------

  /**
   * Generates a SHA-256 hash of a URL string for use as a cache key component.
   *
   * The hash is returned as a lowercase hexadecimal string (64 characters).
   * This ensures:
   * - Constant key length regardless of URL length
   * - No special characters that could interfere with key storage
   * - Virtually zero collision probability for practical usage
   *
   * @param url - The URL to hash. Should be a fully qualified absolute URL.
   * @returns A 64-character lowercase hex string representing the SHA-256 digest.
   *
   * @example
   * ```typescript
   * const hash = cacheManager.hashUrl("https://example.com/page?q=test");
   * // => "a1b2c3d4e5f6..." (64 hex chars)
   * ```
   */
  private hashUrl(url: string): string {
    return crypto.createHash("sha256").update(url).digest("hex");
  }

  // -------------------------------------------------------------------------
  // Page Cache Operations
  // -------------------------------------------------------------------------

  /**
   * Retrieves a cached page by URL.
   *
   * Looks up the page cache namespace using the SHA-256 hash of the URL.
   * Updates hit/miss counters for statistics tracking.
   *
   * @param url - The URL of the page to look up.
   * @returns The cached page data if found and not expired, or `undefined` on miss.
   *
   * @example
   * ```typescript
   * const page = cacheManager.getPage("https://example.com");
   * if (page) {
   *   console.log(`Cache hit! Title: ${page.title}`);
   *   console.log(`Fetched ${Date.now() - page.fetchedAt}ms ago`);
   * } else {
   *   console.log("Cache miss, need to fetch");
   * }
   * ```
   */
  getPage(url: string): CachedPage | undefined {
    const key = `${PAGE_PREFIX}${this.hashUrl(url)}`;
    const result = this.cache.get<CachedPage>(key);

    // Track hit/miss statistics for monitoring.
    // These counters are never reset during the process lifetime, giving us
    // an accurate picture of cache effectiveness since server startup.
    if (result !== undefined) {
      this.hitCount++;
    } else {
      this.missCount++;
    }

    return result;
  }

  /**
   * Stores a page in the cache.
   *
   * The entry will be automatically evicted after the configured TTL.
   * If the cache has reached its maxKeys limit, this will throw an error
   * from node-cache (which the caller should handle gracefully -- a cache
   * set failure should NOT block the response to the user).
   *
   * @param url - The URL that was fetched (used as the cache key basis).
   * @param page - The page data to cache.
   * @returns `true` if the entry was stored successfully, `false` otherwise.
   *
   * @example
   * ```typescript
   * const success = cacheManager.setPage("https://example.com", {
   *   title: "Example Domain",
   *   content: "# Example Domain\n\nThis domain is for ...",
   *   length: 1256,
   *   fetchedAt: Date.now(),
   * });
   *
   * if (!success) {
   *   console.warn("Failed to cache page (cache may be full)");
   * }
   * ```
   */
  setPage(url: string, page: CachedPage): boolean {
    const key = `${PAGE_PREFIX}${this.hashUrl(url)}`;

    try {
      return this.cache.set<CachedPage>(key, page);
    } catch (error) {
      // node-cache throws when maxKeys is exceeded.
      // We catch and return false rather than letting the error propagate,
      // because cache storage failure should never break the main workflow.
      // The page was already fetched successfully -- we just can't cache it.
      return false;
    }
  }

  /**
   * Checks whether a page exists in the cache without affecting hit/miss stats.
   *
   * Useful for pre-flight checks where you want to know if a fetch is needed
   * without counting it as a cache access for statistics purposes.
   *
   * @param url - The URL to check.
   * @returns `true` if the page is cached and has not expired.
   *
   * @example
   * ```typescript
   * if (cacheManager.hasPage("https://example.com")) {
   *   console.log("Page is cached, can skip fetch");
   * }
   * ```
   */
  hasPage(url: string): boolean {
    const key = `${PAGE_PREFIX}${this.hashUrl(url)}`;
    return this.cache.has(key);
  }

  // -------------------------------------------------------------------------
  // Links Cache Operations
  // -------------------------------------------------------------------------

  /**
   * Retrieves cached links for a URL.
   *
   * Looks up the links cache namespace using the SHA-256 hash of the URL.
   * Updates hit/miss counters for statistics tracking.
   *
   * @param url - The URL whose extracted links to look up.
   * @returns The cached links data if found and not expired, or `undefined` on miss.
   *
   * @example
   * ```typescript
   * const cached = cacheManager.getLinks("https://example.com");
   * if (cached) {
   *   console.log(`Found ${cached.links.length} cached links`);
   * }
   * ```
   */
  getLinks(url: string): CachedLinks | undefined {
    const key = `${LINKS_PREFIX}${this.hashUrl(url)}`;
    const result = this.cache.get<CachedLinks>(key);

    if (result !== undefined) {
      this.hitCount++;
    } else {
      this.missCount++;
    }

    return result;
  }

  /**
   * Stores extracted links in the cache.
   *
   * @param url - The URL from which the links were extracted.
   * @param links - The links data to cache.
   * @returns `true` if stored successfully, `false` otherwise.
   *
   * @example
   * ```typescript
   * cacheManager.setLinks("https://example.com", {
   *   links: [
   *     { text: "About", url: "https://example.com/about" },
   *     { text: "Blog", url: "https://example.com/blog" },
   *   ],
   *   fetchedAt: Date.now(),
   * });
   * ```
   */
  setLinks(url: string, links: CachedLinks): boolean {
    const key = `${LINKS_PREFIX}${this.hashUrl(url)}`;

    try {
      return this.cache.set<CachedLinks>(key, links);
    } catch (error) {
      // Same rationale as setPage -- cache storage failure is non-fatal.
      return false;
    }
  }

  /**
   * Checks whether links for a URL exist in the cache without affecting stats.
   *
   * @param url - The URL to check.
   * @returns `true` if links are cached and have not expired.
   *
   * @example
   * ```typescript
   * if (!cacheManager.hasLinks(targetUrl)) {
   *   // Need to fetch and extract links
   * }
   * ```
   */
  hasLinks(url: string): boolean {
    const key = `${LINKS_PREFIX}${this.hashUrl(url)}`;
    return this.cache.has(key);
  }

  // -------------------------------------------------------------------------
  // Cache Management
  // -------------------------------------------------------------------------

  /**
   * Returns comprehensive cache statistics.
   *
   * Provides hit/miss counts, hit rate percentage, and entry counts per
   * namespace. This is useful for:
   * - Monitoring cache effectiveness in production
   * - Tuning TTL and maxKeys parameters
   * - Debugging performance issues
   *
   * @returns An object containing all cache statistics.
   *
   * @example
   * ```typescript
   * const stats = cacheManager.getStats();
   * console.log(JSON.stringify(stats, null, 2));
   * // {
   * //   totalRequests: 150,
   * //   hits: 120,
   * //   misses: 30,
   * //   hitRate: 80,
   * //   pageEntries: 45,
   * //   linkEntries: 32,
   * //   totalEntries: 77
   * // }
   * ```
   */
  getStats(): CacheStats {
    const keys = this.cache.keys();

    // Count entries per namespace by checking key prefixes.
    // This is O(n) over all keys but is only called for diagnostics,
    // not in the hot path, so performance is acceptable.
    const pageEntries = keys.filter((k) => k.startsWith(PAGE_PREFIX)).length;
    const linkEntries = keys.filter((k) => k.startsWith(LINKS_PREFIX)).length;

    const totalRequests = this.hitCount + this.missCount;

    return {
      totalRequests,
      hits: this.hitCount,
      misses: this.missCount,
      // Guard against division by zero when no requests have been made yet.
      hitRate: totalRequests > 0 ? (this.hitCount / totalRequests) * 100 : 0,
      pageEntries,
      linkEntries,
      totalEntries: keys.length,
    };
  }

  /**
   * Removes all entries from both cache namespaces and resets statistics.
   *
   * This is a destructive operation primarily useful for:
   * - Testing (clearing state between test runs)
   * - Manual cache invalidation if stale data is suspected
   * - Memory pressure situations
   *
   * @example
   * ```typescript
   * cacheManager.clear();
   * const stats = cacheManager.getStats();
   * console.log(stats.totalEntries); // => 0
   * console.log(stats.totalRequests); // => 0
   * ```
   */
  clear(): void {
    this.cache.flushAll();
    this.hitCount = 0;
    this.missCount = 0;
  }

  /**
   * Removes a specific page entry from the cache.
   *
   * Useful for forced re-fetching of a single URL without clearing the
   * entire cache.
   *
   * @param url - The URL whose page cache entry should be removed.
   * @returns The number of entries deleted (0 or 1).
   *
   * @example
   * ```typescript
   * cacheManager.invalidatePage("https://example.com");
   * // Next getPage() call for this URL will be a miss
   * ```
   */
  invalidatePage(url: string): number {
    const key = `${PAGE_PREFIX}${this.hashUrl(url)}`;
    return this.cache.del(key);
  }

  /**
   * Removes a specific links entry from the cache.
   *
   * @param url - The URL whose links cache entry should be removed.
   * @returns The number of entries deleted (0 or 1).
   *
   * @example
   * ```typescript
   * cacheManager.invalidateLinks("https://example.com");
   * ```
   */
  invalidateLinks(url: string): number {
    const key = `${LINKS_PREFIX}${this.hashUrl(url)}`;
    return this.cache.del(key);
  }

  /**
   * Removes both page and links entries for a given URL.
   *
   * Convenience method that combines `invalidatePage` and `invalidateLinks`.
   *
   * @param url - The URL to fully invalidate from all cache namespaces.
   * @returns The total number of entries deleted (0, 1, or 2).
   *
   * @example
   * ```typescript
   * const deleted = cacheManager.invalidateUrl("https://example.com");
   * console.log(`Removed ${deleted} cache entries`);
   * ```
   */
  invalidateUrl(url: string): number {
    return this.invalidatePage(url) + this.invalidateLinks(url);
  }
}

// ---------------------------------------------------------------------------
// Singleton Export
// ---------------------------------------------------------------------------

/**
 * The singleton CacheManager instance shared across the entire application.
 *
 * This is the primary export that all other modules should import and use.
 * It is initialized with the configuration values from `config.cacheTtl`
 * and `config.cacheMaxKeys`.
 *
 * @example
 * ```typescript
 * import { cacheManager } from "./services/cache.js";
 *
 * // In a tool handler:
 * const cached = cacheManager.getPage(url);
 * if (cached) return cached;
 *
 * // After fetching:
 * cacheManager.setPage(url, pageData);
 * ```
 */
export const cacheManager = new CacheManager();
