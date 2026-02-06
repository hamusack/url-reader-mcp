/**
 * @module utils/url
 * @fileoverview URL manipulation utilities: normalization, domain extraction,
 * pattern matching, and validation.
 *
 * These functions are used throughout the application wherever URLs need to
 * be compared, filtered, or resolved. The normalization logic is particularly
 * important for the cache layer and the crawler's visited-set, where two
 * superficially different URLs (e.g., with/without trailing slash) must be
 * recognized as the same resource.
 *
 * ## Normalization Rules (applied in order)
 * 1. Parse with the WHATWG URL constructor (rejects malformed URLs early).
 * 2. Lowercase the scheme and hostname (HTTP spec says these are case-insensitive).
 * 3. Remove the fragment (`#section`) -- fragments are client-side only.
 * 4. Remove default ports (`:80` for HTTP, `:443` for HTTPS).
 * 5. Sort query parameters alphabetically by key.
 * 6. Remove trailing slash on the path ONLY when the path is exactly "/".
 *    (We keep trailing slashes on deeper paths because `/foo/` and `/foo`
 *     can be different resources on some servers.)
 *
 * ## Extension Points
 * - `robots.txt` parsing utilities (Phase 2).
 * - Sitemap XML URL extraction (Phase 2).
 * - Custom normalization rules (e.g., strip tracking parameters like `utm_*`).
 * - URL canonicalization using `<link rel="canonical">` from page content.
 *
 * @example
 * ```ts
 * import { normalizeUrl, extractDomain, isFetchableUrl } from "./utils/url.js";
 *
 * normalizeUrl("HTTPS://Example.COM:443/path?b=2&a=1#frag");
 * // => "https://example.com/path?a=1&b=2"
 *
 * extractDomain("https://sub.example.com/path");
 * // => "sub.example.com"
 *
 * isFetchableUrl("javascript:alert(1)");
 * // => false
 * ```
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Default ports for HTTP and HTTPS.
 *
 * Used during normalization to strip redundant port numbers.
 * WHY a Map: O(1) lookup, clearly associates scheme with its default port.
 */
const DEFAULT_PORTS: ReadonlyMap<string, string> = new Map([
  ["http:", "80"],
  ["https:", "443"],
]);

/**
 * Set of URL schemes that this application can actually fetch.
 *
 * WHY a Set instead of an array: `Set.has()` is O(1) and reads more
 * clearly than `array.includes()` when the intent is membership testing.
 *
 * WHY only http/https: We perform HTTP requests. Other schemes like
 * `javascript:`, `data:`, `mailto:`, `tel:`, `ftp:` either represent
 * security risks (XSS injection), are unfetchable, or require entirely
 * different transport mechanisms.
 */
const FETCHABLE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/* ────────────────────────────────────────────────────────────────────────────
 * URL Normalization
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Normalize a URL string into a canonical form for deduplication.
 *
 * Two URLs that point to the same resource should produce the same
 * normalized string. This is critical for:
 * - **Cache key generation:** Avoids fetching the same page twice.
 * - **Crawler visited-set:** Prevents infinite loops on equivalent URLs.
 * - **Link deduplication:** Presents cleaner results to the user.
 *
 * ## Normalization Steps
 * 1. Parse with `new URL()` (validates and decomposes the URL).
 * 2. Lowercase scheme and host (per RFC 3986 section 3.1 & 3.2.2).
 * 3. Remove fragment (per RFC 3986 section 3.5 -- fragments are not sent to server).
 * 4. Remove default port (`:80` for HTTP, `:443` for HTTPS).
 * 5. Sort query parameters alphabetically by key name.
 * 6. Strip lone trailing slash (normalize `https://example.com/` to `https://example.com`).
 *
 * @param url - The raw URL string to normalize. Must be a valid absolute URL.
 * @returns The normalized URL string.
 * @throws {TypeError} If the input is not a valid URL (propagated from `new URL()`).
 *
 * @example
 * ```ts
 * normalizeUrl("HTTPS://Example.COM:443/path?b=2&a=1#section");
 * // => "https://example.com/path?a=1&b=2"
 *
 * normalizeUrl("http://example.com:80/");
 * // => "http://example.com"
 *
 * normalizeUrl("https://example.com/path/?z=1&a=2&m=3");
 * // => "https://example.com/path/?a=2&m=3&z=1"
 * ```
 */
export function normalizeUrl(url: string): string {
  // Step 1: Parse -- this also lowercases scheme and hostname for us,
  // because the URL constructor follows the WHATWG URL Standard which
  // normalizes these components automatically.
  const parsed = new URL(url);

  // Step 2: Remove fragment. The WHATWG URL constructor preserves
  // fragments, but they have no meaning for HTTP requests -- the
  // fragment is never sent to the server.
  parsed.hash = "";

  // Step 3: Remove default ports. The URL constructor sometimes
  // normalizes these away on its own, but we do it explicitly to be
  // safe across all runtimes. An empty string means "no port specified"
  // which defaults to the scheme's standard port.
  if (parsed.port === DEFAULT_PORTS.get(parsed.protocol)) {
    parsed.port = "";
  }

  // Step 4: Sort query parameters alphabetically by key.
  // WHY: Query parameter order is not semantically meaningful for most
  // web servers (the HTTP spec doesn't define parameter ordering).
  // Sorting ensures that `?a=1&b=2` and `?b=2&a=1` produce the same
  // normalized URL. We use the built-in URLSearchParams.sort() which
  // sorts by code unit order of the key names.
  parsed.searchParams.sort();

  // Step 5: Convert back to string and handle trailing slash.
  let normalized = parsed.toString();

  // WHY only strip trailing slash when the path is exactly "/":
  // For root URLs like "https://example.com/", removing the slash
  // gives "https://example.com" which is the canonical form. But for
  // deeper paths like "https://example.com/blog/", the trailing slash
  // might be semantically different from "/blog" on some servers
  // (e.g., Apache directory listings). So we leave those alone.
  if (parsed.pathname === "/" && !parsed.search) {
    // Remove the trailing "/" only when there are no query params.
    // With query params, "https://example.com/?q=1" should stay as-is
    // because removing the slash would give "https://example.com?q=1"
    // which, while equivalent, looks unusual.
    normalized = normalized.replace(/\/$/, "");
  }

  return normalized;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Domain Extraction
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Extract the hostname (domain) from a URL string.
 *
 * Returns the full hostname including subdomains, lowercased.
 * This is used for:
 * - **Per-domain rate limiting:** Throttle requests to the same origin.
 * - **Domain-scoped crawling:** Restrict BFS to a specific domain.
 * - **Security checks:** Compare against allowed/blocked domain lists.
 *
 * @param url - A valid absolute URL string.
 * @returns The lowercased hostname (e.g., `"sub.example.com"`).
 * @throws {TypeError} If the input is not a valid URL.
 *
 * @example
 * ```ts
 * extractDomain("https://Sub.Example.COM:8080/path?q=1");
 * // => "sub.example.com"
 *
 * extractDomain("http://localhost:3000/api");
 * // => "localhost"
 * ```
 */
export function extractDomain(url: string): string {
  // WHY use new URL() rather than regex: The URL constructor handles
  // all the edge cases (IPv6 brackets, IDN encoding, userinfo stripping)
  // that a regex would struggle with. The performance cost of constructing
  // a URL object is negligible compared to the network I/O we'll do next.
  const parsed = new URL(url);
  return parsed.hostname;
}

/* ────────────────────────────────────────────────────────────────────────────
 * URL Resolution
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve a potentially relative URL against a base URL.
 *
 * This is essential for link extraction during crawling: `<a href="/about">`
 * on page `https://example.com/docs/intro` should resolve to
 * `https://example.com/about`.
 *
 * Delegates to the WHATWG URL constructor's two-argument form, which
 * correctly handles all relative URL forms defined in RFC 3986:
 * - Protocol-relative: `//other.com/path`
 * - Absolute path: `/path`
 * - Relative path: `../sibling`, `./child`, `child`
 * - Query-only: `?q=1`
 * - Fragment-only: `#section`
 *
 * @param base     - The base URL (typically the page that contains the link).
 * @param relative - The URL to resolve (can be absolute or relative).
 * @returns The fully resolved absolute URL string.
 * @throws {TypeError} If `base` is not a valid URL, or if `relative` combined
 *                     with `base` does not produce a valid URL.
 *
 * @example
 * ```ts
 * resolveUrl("https://example.com/docs/intro", "/about");
 * // => "https://example.com/about"
 *
 * resolveUrl("https://example.com/docs/intro", "../blog");
 * // => "https://example.com/blog"
 *
 * resolveUrl("https://example.com/docs/intro", "https://other.com");
 * // => "https://other.com"  (absolute URL ignores base)
 * ```
 */
export function resolveUrl(base: string, relative: string): string {
  // WHY two-argument URL constructor: This is the standard way to resolve
  // relative URLs in JavaScript. When `relative` is already absolute, the
  // `base` parameter is ignored (per spec). When `relative` is relative,
  // it's resolved against `base` following RFC 3986 rules.
  return new URL(relative, base).href;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pattern Matching
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Check whether a URL matches a glob-like pattern.
 *
 * Supports the `*` wildcard which matches any sequence of characters
 * (including none). This is used by the `crawl` tool's include/exclude
 * pattern feature, allowing users to specify patterns like:
 * - `"https://docs.example.com/*"` -- match all pages under docs
 * - `"*.pdf"` -- match all URLs ending in .pdf
 * - `"https://example.com/blog/star/comments"` -- match comment pages
 *
 * ## Pattern Syntax
 * - The `*` wildcard matches zero or more of any character (equivalent to `.*` in regex).
 * - All other characters are matched literally (regex metacharacters are escaped).
 * - The match is case-insensitive (URLs are case-insensitive in scheme and host).
 * - The entire URL must match (pattern is anchored with `^` and `$`).
 *
 * @param url     - The URL to test.
 * @param pattern - The glob-like pattern (supports `*` wildcard).
 * @returns `true` if the URL matches the pattern.
 *
 * @example
 * ```ts
 * matchesPattern("https://example.com/blog/post-1", "https://example.com/blog/*");
 * // => true
 *
 * matchesPattern("https://example.com/about", "https://example.com/blog/*");
 * // => false
 *
 * matchesPattern("https://cdn.example.com/file.pdf", "*.pdf");
 * // => true
 * ```
 */
export function matchesPattern(url: string, pattern: string): boolean {
  // Step 1: Escape all regex metacharacters in the pattern EXCEPT our
  // wildcard (*). We need to be careful here because the pattern contains
  // URL characters that happen to be regex metacharacters too:
  // dots (.), question marks (?), plus signs (+), etc.
  //
  // WHY escape first, then replace *: If we replaced * first, the
  // resulting ".*" would get its "." escaped in the next step. By
  // escaping everything first and then replacing the escaped "\*" with
  // ".*", we get the correct regex.
  const escapedPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape regex metacharacters
    .replace(/\*/g, ".*"); // Convert glob * to regex .*

  // Step 2: Create a case-insensitive regex anchored to match the full URL.
  // WHY anchored: Without ^ and $, the pattern "*blog*" would match
  // partial URLs, which is technically correct for glob semantics but
  // could be confusing. Full anchoring makes the behavior predictable.
  const regex = new RegExp(`^${escapedPattern}$`, "i");

  return regex.test(url);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Domain Filtering
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Check whether a URL's domain is present in an allowed-domains list.
 *
 * Used by the crawler to enforce domain-scoped crawling. When the user
 * specifies `allowedDomains: ["example.com"]`, only links pointing to
 * `example.com` (or its subdomains) should be followed.
 *
 * ## Matching Rules
 * - Exact match: `"example.com"` matches `"example.com"`.
 * - Subdomain match: `"example.com"` also matches `"sub.example.com"`,
 *   `"a.b.example.com"`, etc. This is intentional because users typically
 *   want to include all subdomains when they allow a domain.
 * - The comparison is case-insensitive (domains are case-insensitive per RFC 4343).
 *
 * @param url            - The URL whose domain to check.
 * @param allowedDomains - List of allowed domain strings.
 * @returns `true` if the URL's domain matches or is a subdomain of any allowed domain.
 *
 * @example
 * ```ts
 * isDomainAllowed("https://docs.example.com/page", ["example.com"]);
 * // => true (subdomain match)
 *
 * isDomainAllowed("https://example.com/page", ["example.com"]);
 * // => true (exact match)
 *
 * isDomainAllowed("https://evil.com/page", ["example.com"]);
 * // => false
 *
 * isDomainAllowed("https://notexample.com/page", ["example.com"]);
 * // => false (not a subdomain -- "notexample.com" doesn't end with ".example.com")
 * ```
 */
export function isDomainAllowed(
  url: string,
  allowedDomains: string[],
): boolean {
  // WHY lowercase: Domain comparison must be case-insensitive.
  // extractDomain() already returns lowercase (URL constructor normalizes),
  // but we lowercase the allowed list too for safety.
  const domain = extractDomain(url).toLowerCase();

  return allowedDomains.some((allowed) => {
    const normalizedAllowed = allowed.toLowerCase();

    // Exact match: "example.com" === "example.com"
    if (domain === normalizedAllowed) {
      return true;
    }

    // Subdomain match: "sub.example.com" ends with ".example.com"
    // WHY the dot prefix: Without it, "notexample.com" would incorrectly
    // match the allowed domain "example.com" because "notexample.com"
    // ends with "example.com". The dot ensures we're matching at a
    // subdomain boundary.
    if (domain.endsWith(`.${normalizedAllowed}`)) {
      return true;
    }

    return false;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * URL Scheme Validation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Check whether a URL uses a scheme that this application can fetch.
 *
 * Only `http:` and `https:` URLs are fetchable. All other schemes are
 * rejected to prevent:
 * - **Security issues:** `javascript:` URLs could be interpreted as code
 *   in some contexts. `data:` URLs could encode malicious payloads.
 * - **Functional issues:** `mailto:`, `tel:`, `ftp:`, `file:` URLs
 *   cannot be fetched with standard HTTP libraries.
 * - **Resource issues:** `data:` URLs could encode very large payloads
 *   that bypass our response size limits.
 *
 * @param url - The URL string to validate.
 * @returns `true` if the URL uses `http:` or `https:`.
 *
 * @example
 * ```ts
 * isFetchableUrl("https://example.com/page");
 * // => true
 *
 * isFetchableUrl("http://example.com/api");
 * // => true
 *
 * isFetchableUrl("javascript:alert(1)");
 * // => false
 *
 * isFetchableUrl("mailto:user@example.com");
 * // => false
 *
 * isFetchableUrl("data:text/html,<h1>Hi</h1>");
 * // => false
 *
 * isFetchableUrl("not-a-valid-url");
 * // => false (URL constructor throws, caught and returned as false)
 * ```
 */
export function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return FETCHABLE_SCHEMES.has(parsed.protocol);
  } catch {
    // WHY catch without re-throwing: An invalid URL is definitionally
    // not fetchable. Rather than forcing every caller to handle both
    // the boolean return AND a potential TypeError, we absorb the
    // exception here and return false. The caller will typically call
    // this function as a guard before attempting to fetch, so returning
    // false correctly prevents the fetch attempt.
    return false;
  }
}
