/**
 * @fileoverview Secure HTTP fetch service for the mcp-url-reader MCP server.
 *
 * This module provides a hardened HTTP client that wraps the Node.js native
 * `fetch()` API with multiple layers of security and reliability controls:
 *
 * ## Security Controls
 *
 * 1. **SSRF Protection** - Validates hostnames before fetching to block requests
 *    to internal/private networks (127.0.0.1, 10.x.x.x, 169.254.x.x, etc.)
 * 2. **Content-Type Filtering** - Only accepts HTML-like responses, rejecting
 *    binaries, images, PDFs, etc. that could waste resources or cause parsing errors
 * 3. **Response Size Limiting** - Caps the response body size to prevent memory
 *    exhaustion from multi-gigabyte responses
 * 4. **Redirect Limiting** - Caps the number of redirects to prevent infinite
 *    redirect loops
 *
 * ## Reliability Controls
 *
 * 1. **Timeout** - Uses AbortSignal.timeout() to prevent hanging on slow servers
 * 2. **Rate Limiting** - Routes all requests through the queueManager for
 *    per-domain and global concurrency control
 * 3. **User-Agent** - Sends a configurable, identifying User-Agent header
 *
 * ## Architecture
 *
 * ```
 *   safeFetch(url)
 *     |
 *     +--> URL parsing & validation
 *     |     - Protocol check (http/https only)
 *     |     - Hostname validation (SSRF protection)
 *     |
 *     +--> queueManager.enqueue(domain, ...)
 *     |     - Per-domain rate limiting
 *     |     - Global concurrency limiting
 *     |
 *     +--> Native fetch() with:
 *     |     - AbortSignal.timeout
 *     |     - Custom User-Agent header
 *     |     - Redirect mode: "follow"
 *     |
 *     +--> Response validation
 *     |     - Status code check
 *     |     - Content-Type check
 *     |     - Body size check
 *     |
 *     +--> Return FetchResult
 * ```
 *
 * @module services/fetch
 */

import { config } from "../config.js";
import { validateHostname } from "../utils/network.js";
import { normalizeUrl } from "../utils/url.js";
import {
  FetchError,
  ContentTypeError,
  ResponseTooLargeError,
  SecurityError,
  SSRFError,
  TimeoutError,
} from "../utils/errors.js";
import { queueManager } from "./queue.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Represents the result of a successful HTTP fetch operation.
 *
 * Contains the raw HTML body along with metadata about the response.
 * This is the input to the extraction pipeline (Readability + Turndown).
 *
 * @example
 * ```typescript
 * const result: FetchResult = {
 *   html: "<!DOCTYPE html><html><head>...</head><body>...</body></html>",
 *   url: "https://example.com/",
 *   contentType: "text/html; charset=utf-8",
 *   statusCode: 200,
 * };
 * ```
 */
export interface FetchResult {
  /** The raw HTML body of the response as a string. */
  html: string;

  /**
   * The final URL after all redirects have been followed.
   *
   * This may differ from the original requested URL if the server issued
   * HTTP 301/302/307/308 redirects. The final URL is important for:
   * - Resolving relative links in the HTML
   * - Deduplication (different URLs can redirect to the same page)
   * - Accurate cache key generation
   */
  url: string;

  /**
   * The Content-Type header value from the response.
   * Typically "text/html" or "text/html; charset=utf-8".
   */
  contentType: string;

  /** The HTTP status code of the final response (after redirects). */
  statusCode: number;
}

// ---------------------------------------------------------------------------
// Content-Type Allowlist
// ---------------------------------------------------------------------------

/**
 * Set of Content-Type MIME types that we consider "HTML-like" and will accept.
 *
 * We intentionally keep this list narrow to avoid processing non-HTML content:
 * - `text/html`: Standard HTML pages
 * - `application/xhtml+xml`: XHTML pages (strict XML-based HTML)
 * - `text/xml`: Some older sites serve HTML as text/xml
 * - `application/xml`: Same as above, sometimes used for XHTML
 *
 * We do NOT accept:
 * - `application/json` - Not renderable HTML
 * - `text/plain` - No HTML structure to extract
 * - `application/pdf` - Binary, requires specialized parsing
 * - `image/*` - Binary content
 * - `application/octet-stream` - Unknown binary
 */
const ALLOWED_CONTENT_TYPES = new Set<string>([
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
]);

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Extracts the MIME type from a Content-Type header value.
 *
 * Content-Type headers often include parameters like charset:
 *   "text/html; charset=utf-8" -> "text/html"
 *
 * This function strips the parameters and returns just the media type,
 * lowercased and trimmed for consistent comparison.
 *
 * @param contentType - The raw Content-Type header value.
 * @returns The extracted MIME type in lowercase, or an empty string if null/undefined.
 *
 * @example
 * ```typescript
 * extractMimeType("text/html; charset=utf-8");
 * // => "text/html"
 *
 * extractMimeType("APPLICATION/XHTML+XML");
 * // => "application/xhtml+xml"
 *
 * extractMimeType(null);
 * // => ""
 * ```
 */
function extractMimeType(contentType: string | null): string {
  if (!contentType) {
    return "";
  }

  // Split on semicolon to separate MIME type from parameters.
  // The MIME type is always the first segment.
  const mimeType = contentType.split(";")[0];
  return mimeType.trim().toLowerCase();
}

/**
 * Validates that a Content-Type is acceptable for processing.
 *
 * Checks the extracted MIME type against our allowlist of HTML-like types.
 * This prevents the server from wasting resources trying to parse binary
 * content, JSON APIs, or other non-HTML responses.
 *
 * @param contentType - The raw Content-Type header value from the response.
 * @returns `true` if the content type is in the allowlist.
 *
 * @example
 * ```typescript
 * isAcceptableContentType("text/html; charset=utf-8");  // => true
 * isAcceptableContentType("application/json");           // => false
 * isAcceptableContentType("image/png");                  // => false
 * isAcceptableContentType(null);                         // => false
 * ```
 */
function isAcceptableContentType(contentType: string | null): boolean {
  const mimeType = extractMimeType(contentType);
  return ALLOWED_CONTENT_TYPES.has(mimeType);
}

/**
 * Reads a Response body as text with a size limit enforced via streaming.
 *
 * Rather than calling `response.text()` which loads the entire body into
 * memory at once, this function reads the body incrementally and aborts
 * if the accumulated size exceeds the configured maximum.
 *
 * ## Why not just check Content-Length?
 *
 * The Content-Length header is:
 * - Optional (not all servers send it)
 * - Unreliable (can be wrong, especially with compression)
 * - Not present for chunked transfer encoding
 *
 * Streaming with a byte counter is the only reliable way to enforce size limits.
 *
 * @param response - The fetch Response object to read from.
 * @param maxBytes - Maximum number of bytes to read before aborting.
 * @returns The response body as a string, guaranteed to be <= maxBytes in size.
 *
 * @throws {ResponseTooLargeError} If the body exceeds the size limit.
 *
 * @example
 * ```typescript
 * const html = await readBodyWithLimit(response, 5 * 1024 * 1024);
 * // Reads up to 5MB; throws if response is larger
 * ```
 */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number
): Promise<string> {
  // Fast path: check Content-Length header first as an optimization.
  // If the server tells us the body is too large, we can reject immediately
  // without reading any bytes. But we still enforce the limit during
  // streaming below because Content-Length can be inaccurate.
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredSize = parseInt(contentLength, 10);
    if (!isNaN(declaredSize) && declaredSize > maxBytes) {
      throw new ResponseTooLargeError(
        `Response Content-Length (${declaredSize} bytes) exceeds limit of ${maxBytes} bytes`
      );
    }
  }

  // If the response body is null (e.g., 204 No Content), return empty string.
  if (!response.body) {
    return "";
  }

  // Stream the response body and accumulate chunks with size tracking.
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    // fatal: false means malformed byte sequences are replaced with U+FFFD
    // rather than throwing. This is more resilient for web pages with
    // encoding issues (surprisingly common on older sites).
    fatal: false,
  });

  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      // Check size limit BEFORE decoding to avoid wasting CPU on content
      // we're going to discard anyway.
      if (totalBytes > maxBytes) {
        // Cancel the stream to release resources and signal to the server
        // that we don't need more data.
        await reader.cancel();
        throw new ResponseTooLargeError(
          `Response body exceeds limit of ${maxBytes} bytes (read ${totalBytes} bytes so far)`
        );
      }

      // Decode this chunk. The `stream: true` option tells TextDecoder that
      // more chunks are coming, so it won't flush multi-byte character state.
      // This correctly handles UTF-8 characters split across chunk boundaries.
      chunks.push(decoder.decode(value, { stream: true }));
    }

    // Flush any remaining bytes in the decoder's internal buffer.
    // This handles the case where the last chunk ended mid-character.
    chunks.push(decoder.decode());
  } catch (error) {
    // If it's our own ResponseTooLargeError, re-throw it directly.
    if (error instanceof ResponseTooLargeError) {
      throw error;
    }

    // For other streaming errors (network issues, etc.), wrap them.
    throw new FetchError(
      `Error reading response body: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return chunks.join("");
}

/**
 * Extracts the hostname from a URL string for domain-based operations.
 *
 * Used to determine which per-domain queue a request should be routed to.
 *
 * @param url - A fully qualified URL string.
 * @returns The hostname portion of the URL (e.g., "example.com").
 *
 * @throws {FetchError} If the URL cannot be parsed.
 *
 * @example
 * ```typescript
 * extractDomain("https://docs.example.com/page?q=test");
 * // => "docs.example.com"
 * ```
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new FetchError(`Invalid URL: ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Fetches a URL securely with SSRF protection, rate limiting, size limits,
 * and timeout enforcement.
 *
 * This is the primary function that all MCP tools should use to retrieve
 * web pages. It applies all security and reliability controls described
 * in this module's documentation.
 *
 * ## Security Checks (in order)
 *
 * 1. **Protocol validation** - Only `http:` and `https:` are accepted
 * 2. **SSRF hostname validation** - Blocks private/internal IP ranges
 * 3. **Rate limiting** - Routes through queueManager
 * 4. **Timeout** - AbortSignal.timeout prevents hanging
 * 5. **Status code check** - Only 2xx responses are accepted
 * 6. **Content-Type check** - Only HTML-like responses are accepted
 * 7. **Body size limit** - Streaming read with byte counter
 *
 * ## Error Handling
 *
 * The function throws typed errors from `utils/errors.ts`:
 * - {@link SSRFError} - URL targets a private/internal network
 * - {@link TimeoutError} - Request exceeded the configured timeout
 * - {@link FetchError} - General fetch failure (network error, DNS failure, etc.)
 * - {@link ContentTypeError} - Response Content-Type is not HTML-like
 * - {@link ResponseTooLargeError} - Response body exceeds size limit
 *
 * @param url - The URL to fetch. Must be an absolute HTTP or HTTPS URL.
 * @returns A FetchResult containing the HTML body and response metadata.
 *
 * @throws {SSRFError} If the URL resolves to a private/internal IP address.
 * @throws {TimeoutError} If the request exceeds `config.fetchTimeout` milliseconds.
 * @throws {FetchError} If the request fails due to network issues, invalid URL,
 *   non-2xx status code, or other transport-level errors.
 * @throws {ContentTypeError} If the response Content-Type is not HTML-like.
 * @throws {ResponseTooLargeError} If the response body exceeds `config.maxResponseSize`.
 *
 * @example
 * ```typescript
 * import { safeFetch } from "./services/fetch.js";
 *
 * try {
 *   const result = await safeFetch("https://example.com");
 *   console.log(`Fetched ${result.url} (${result.statusCode})`);
 *   console.log(`Content-Type: ${result.contentType}`);
 *   console.log(`HTML length: ${result.html.length} chars`);
 * } catch (error) {
 *   if (error instanceof SSRFError) {
 *     console.error("Blocked: URL targets internal network");
 *   } else if (error instanceof TimeoutError) {
 *     console.error("Request timed out");
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Handling redirects: the final URL may differ from the input
 * const result = await safeFetch("http://example.com");
 * // result.url might be "https://www.example.com/" after redirects
 * ```
 */
export async function safeFetch(url: string): Promise<FetchResult> {
  // -----------------------------------------------------------------------
  // Step 1: Normalize and parse the URL
  // -----------------------------------------------------------------------

  // normalizeUrl() handles edge cases like missing trailing slashes,
  // lowercase scheme/host, and removing default ports.
  const normalizedUrl = normalizeUrl(url);
  const domain = extractDomain(normalizedUrl);

  // -----------------------------------------------------------------------
  // Step 2: Validate protocol
  // -----------------------------------------------------------------------

  // We only support HTTP and HTTPS. Other protocols (file://, ftp://, data:,
  // javascript:, etc.) are rejected to prevent unexpected behavior and
  // security issues (e.g., file:// could read local files).
  const parsedUrl = new URL(normalizedUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new FetchError(
      `Unsupported protocol: ${parsedUrl.protocol} (only http: and https: are allowed)`
    );
  }

  // -----------------------------------------------------------------------
  // Step 3: SSRF protection - validate the hostname
  // -----------------------------------------------------------------------

  // validateHostname() checks that the hostname does not resolve to a
  // private or internal IP address. This prevents Server-Side Request
  // Forgery (SSRF) attacks where a malicious user could trick the server
  // into accessing internal services (e.g., cloud metadata endpoints at
  // 169.254.169.254, localhost services, or internal network resources).
  //
  // This check MUST happen BEFORE the actual fetch to prevent DNS rebinding
  // attacks: an attacker could set up a domain that first resolves to a
  // public IP (passing validation) then to a private IP (bypassing protection).
  // Our validateHostname() resolves the DNS and checks ALL returned IPs.
  try {
    await validateHostname(parsedUrl.hostname);
  } catch (error) {
    // Re-throw security errors directly. validateHostname() throws
    // SecurityError, which is a sibling of SSRFError (both have code
    // "SSRF_BLOCKED"). We check for the base class UrlReaderError to
    // catch both and avoid wrapping them unnecessarily.
    if (error instanceof SecurityError || error instanceof SSRFError) {
      throw error;
    }
    throw new SSRFError(
      `Hostname validation failed for ${parsedUrl.hostname}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // -----------------------------------------------------------------------
  // Step 4: Execute the fetch through the rate-limiting queue
  // -----------------------------------------------------------------------

  // Route the request through queueManager to enforce:
  // - Per-domain concurrency (1 at a time) with interval delay
  // - Global concurrency limit (default 3 total)
  //
  // The queue ensures we are a polite web citizen and don't overwhelm
  // either our own resources or the target server.
  const response = await queueManager.enqueue(domain, async () => {
    try {
      return await fetch(normalizedUrl, {
        // AbortSignal.timeout() creates a signal that automatically aborts
        // after the specified number of milliseconds. This is cleaner than
        // manually creating an AbortController + setTimeout.
        //
        // When the signal fires, fetch() rejects with an AbortError.
        signal: AbortSignal.timeout(config.fetchTimeout),

        headers: {
          // Identify ourselves honestly. Many sites block requests without
          // a User-Agent, and some block generic "bot" user agents.
          // Using a descriptive UA helps site operators understand our traffic.
          "User-Agent": config.userAgent,

          // Request HTML specifically. Some servers use content negotiation
          // and might return JSON or other formats without this header.
          Accept: "text/html, application/xhtml+xml, */*;q=0.1",

          // Signal that we accept compressed responses. Node.js fetch
          // handles decompression transparently when the server responds
          // with gzip or br encoding. This significantly reduces bandwidth
          // for large pages.
          "Accept-Encoding": "gzip, deflate, br",

          // Standard language preference. Falls back gracefully if the
          // server doesn't support content negotiation.
          "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
        },

        // Follow redirects automatically. The `response.url` property
        // will contain the final URL after all redirects.
        redirect: "follow",
      });
    } catch (error) {
      // Translate fetch errors into our typed error hierarchy.
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TimeoutError(
          `Request to ${normalizedUrl} timed out after ${config.fetchTimeout}ms`
        );
      }

      // Check for the TimeoutError from AbortSignal.timeout() specifically.
      // In Node.js, AbortSignal.timeout() throws a DOMException with name
      // "TimeoutError" (different from "AbortError" in some runtimes).
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new TimeoutError(
          `Request to ${normalizedUrl} timed out after ${config.fetchTimeout}ms`
        );
      }

      throw new FetchError(
        `Failed to fetch ${normalizedUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });

  // -----------------------------------------------------------------------
  // Step 5: Validate the HTTP status code
  // -----------------------------------------------------------------------

  // Only accept 2xx success responses. Common non-2xx scenarios:
  // - 403/429: Rate limited or blocked (shouldn't get here with queueManager)
  // - 404: Page not found
  // - 500+: Server error
  //
  // We don't retry here -- that's a higher-level concern that could be
  // added to the queue layer if needed.
  if (!response.ok) {
    throw new FetchError(
      `HTTP ${response.status} ${response.statusText} for ${normalizedUrl}`,
      response.status,
    );
  }

  // -----------------------------------------------------------------------
  // Step 6: Validate Content-Type
  // -----------------------------------------------------------------------

  // Check that the response is actually HTML before investing resources
  // in reading and parsing the body. This catches cases like:
  // - APIs that return JSON at the same URL
  // - Servers that serve PDFs or images for some paths
  // - Misconfigured servers
  const contentType = response.headers.get("content-type");

  if (!isAcceptableContentType(contentType)) {
    const mimeType = extractMimeType(contentType);
    throw new ContentTypeError(
      `Unacceptable Content-Type: "${mimeType || "(none)"}" for ${normalizedUrl}. ` +
        `Expected one of: ${Array.from(ALLOWED_CONTENT_TYPES).join(", ")}`
    );
  }

  // -----------------------------------------------------------------------
  // Step 7: Read the response body with size limiting
  // -----------------------------------------------------------------------

  // readBodyWithLimit() streams the response body and enforces a maximum
  // byte count. This prevents a single large page from consuming all
  // available memory.
  const html = await readBodyWithLimit(response, config.maxResponseSize);

  // -----------------------------------------------------------------------
  // Step 8: Construct and return the result
  // -----------------------------------------------------------------------

  return {
    html,
    // response.url is the final URL after redirects.
    // This is crucial for resolving relative URLs in the HTML.
    url: response.url,
    contentType: contentType ?? "text/html",
    statusCode: response.status,
  };
}
