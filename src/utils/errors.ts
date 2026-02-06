/**
 * @module utils/errors
 * @fileoverview Custom error class hierarchy for mcp-url-reader.
 *
 * Every error in this application extends {@link UrlReaderError}, which
 * carries a machine-readable `code` string alongside the human-readable
 * `message`. This dual representation lets MCP tool responses include
 * both a user-friendly explanation and a programmatic error code that
 * callers (LLMs or orchestrators) can branch on.
 *
 * ## Error Hierarchy
 * ```
 * Error (built-in)
 *   └── UrlReaderError (base)  ─── code: string
 *         ├── FetchError          ─── "FETCH_FAILED"   + optional statusCode
 *         ├── SecurityError       ─── "SSRF_BLOCKED"
 *         ├── ExtractionError     ─── "EXTRACTION_FAILED"
 *         ├── TimeoutError        ─── "TIMEOUT"
 *         └── TokenLimitError     ─── "TOKEN_LIMIT_REACHED"
 * ```
 *
 * ## Design Decisions
 *
 * ### Why custom errors instead of plain Error + code field?
 * `instanceof` checks are more readable and type-safe than string comparisons.
 * A caller can write `catch (e) { if (e instanceof SecurityError) ... }` which
 * is self-documenting and survives refactoring better than `if (e.code === "SSRF_BLOCKED")`.
 *
 * ### Why a `code` field on every error?
 * When errors cross serialization boundaries (e.g., returned in an MCP response),
 * the class hierarchy is lost. The `code` field preserves error identity in
 * serialized form, enabling the consuming LLM to react appropriately.
 *
 * ### Why does the base class set `this.name`?
 * `Error.name` defaults to "Error" for all subclasses. Setting it to
 * `this.constructor.name` ensures stack traces show "FetchError:" rather
 * than "Error:", which dramatically improves debuggability.
 *
 * ## Extension Points
 * - Add new error subclasses as new failure modes emerge.
 * - Attach structured metadata (e.g., failed URL, HTTP headers) to subclasses.
 * - {@link formatErrorForMcp} is the single exit point -- extend it to control
 *   how all errors are presented to the MCP caller.
 *
 * @example
 * ```ts
 * import { FetchError, formatErrorForMcp } from "./utils/errors.js";
 *
 * try {
 *   throw new FetchError("Server returned 503", 503);
 * } catch (err) {
 *   console.error(formatErrorForMcp(err));
 *   // => "[FETCH_FAILED] Server returned 503"
 * }
 * ```
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Base Error Class
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Base error class for all mcp-url-reader errors.
 *
 * All application-specific errors MUST extend this class so that:
 * 1. They carry a machine-readable {@link code}.
 * 2. They can be uniformly caught with `instanceof UrlReaderError`.
 * 3. Their `name` property reflects the actual class for readable stack traces.
 *
 * @example
 * ```ts
 * try {
 *   await fetchPage(url);
 * } catch (err) {
 *   if (err instanceof UrlReaderError) {
 *     // All our errors -- can switch on err.code
 *     logger.warn(`[${err.code}] ${err.message}`);
 *   } else {
 *     // Unexpected errors (e.g., ENOMEM, V8 internal)
 *     throw err;
 *   }
 * }
 * ```
 */
export class UrlReaderError extends Error {
  /**
   * Machine-readable error code.
   *
   * Codes follow SCREAMING_SNAKE_CASE convention and are stable across
   * versions -- they form part of the public API surface. Changing a code
   * string is a breaking change.
   *
   * @example "FETCH_FAILED", "SSRF_BLOCKED", "TIMEOUT"
   */
  public readonly code: string;

  /**
   * @param message - Human-readable description of what went wrong.
   * @param code    - Stable machine-readable error code (SCREAMING_SNAKE_CASE).
   */
  constructor(message: string, code: string) {
    super(message);

    // WHY: By default, all Error subclasses have name === "Error".
    // Overriding with the actual class name makes stack traces and
    // console output vastly more informative.
    this.name = this.constructor.name;

    this.code = code;

    // WHY: In environments that support Error.captureStackTrace (V8/Node),
    // this removes the constructor frame from the stack trace, so the
    // trace points directly at the throw site rather than inside the
    // error constructor. This is a Node.js best practice for custom errors.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Concrete Error Subclasses
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Thrown when an HTTP fetch operation fails.
 *
 * Covers network-level failures (DNS resolution, TCP connect, TLS handshake)
 * as well as HTTP-level failures (4xx, 5xx status codes). The optional
 * {@link statusCode} field is populated when the server did respond.
 *
 * @example
 * ```ts
 * // Network error (no status code):
 * throw new FetchError("DNS resolution failed for example.invalid");
 *
 * // HTTP error (with status code):
 * throw new FetchError("Server returned 503 Service Unavailable", 503);
 * ```
 */
export class FetchError extends UrlReaderError {
  /**
   * HTTP status code from the server, if the request reached the server.
   *
   * `undefined` when the failure is at the network level (DNS, TCP, TLS)
   * and no HTTP response was received at all.
   */
  public readonly statusCode?: number;

  /**
   * @param message    - Description of the fetch failure.
   * @param statusCode - HTTP status code, if available.
   */
  constructor(message: string, statusCode?: number) {
    super(message, "FETCH_FAILED");
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when a request is blocked for security reasons.
 *
 * The primary use case is SSRF prevention: if a URL resolves to a private
 * IP address (loopback, RFC 1918, link-local), the request is blocked
 * before any network traffic leaves the host.
 *
 * This error should NEVER be caught and retried -- the block is intentional.
 *
 * @example
 * ```ts
 * // Blocked because the URL resolves to 127.0.0.1:
 * throw new SecurityError(
 *   "Hostname 'internal.corp' resolves to private IP 127.0.0.1"
 * );
 * ```
 */
export class SecurityError extends UrlReaderError {
  /**
   * @param message - Description of why the request was blocked.
   */
  constructor(message: string) {
    super(message, "SSRF_BLOCKED");
  }
}

/**
 * Thrown when a request is blocked due to SSRF (Server-Side Request Forgery).
 *
 * Alias/specialization of SecurityError for use in the fetch layer.
 * While {@link SecurityError} is the general-purpose security block,
 * SSRFError explicitly names the attack vector for clarity in fetch code.
 *
 * @example
 * ```ts
 * throw new SSRFError(
 *   "Hostname 'internal.corp' resolves to private IP 10.0.0.1"
 * );
 * ```
 */
export class SSRFError extends UrlReaderError {
  constructor(message: string) {
    super(message, "SSRF_BLOCKED");
  }
}

/**
 * Thrown when the response Content-Type is not an acceptable HTML type.
 *
 * The fetch layer only processes HTML-like responses. If a server returns
 * JSON, PDF, images, or other non-HTML content, this error is thrown to
 * prevent wasting resources on unparseable content.
 *
 * @example
 * ```ts
 * throw new ContentTypeError(
 *   'Unacceptable Content-Type: "application/json" for https://api.example.com'
 * );
 * ```
 */
export class ContentTypeError extends UrlReaderError {
  constructor(message: string) {
    super(message, "CONTENT_TYPE_REJECTED");
  }
}

/**
 * Thrown when the HTTP response body exceeds the configured size limit.
 *
 * This prevents memory exhaustion from very large pages (e.g., auto-generated
 * documentation pages, data dumps served as HTML). The limit is enforced via
 * streaming reads, so we never buffer more than the limit in memory.
 *
 * @example
 * ```ts
 * throw new ResponseTooLargeError(
 *   "Response body exceeds limit of 10485760 bytes"
 * );
 * ```
 */
export class ResponseTooLargeError extends UrlReaderError {
  constructor(message: string) {
    super(message, "RESPONSE_TOO_LARGE");
  }
}

/**
 * Thrown when content extraction or parsing fails.
 *
 * This covers failures in the HTML-to-Markdown pipeline: DOM parsing errors,
 * Readability failures, Turndown conversion issues, or content that is
 * completely empty after extraction.
 *
 * @example
 * ```ts
 * // Empty extraction result:
 * throw new ExtractionError(
 *   "Readability returned no content for https://example.com/video-only"
 * );
 *
 * // Parse failure:
 * throw new ExtractionError(
 *   "Failed to parse HTML: unclosed tag at position 1234"
 * );
 * ```
 */
export class ExtractionError extends UrlReaderError {
  /**
   * @param message - Description of the extraction failure.
   */
  constructor(message: string) {
    super(message, "EXTRACTION_FAILED");
  }
}

/**
 * Thrown when an HTTP request or overall operation exceeds its time budget.
 *
 * Distinct from {@link FetchError} because timeouts often warrant different
 * handling: the server might be up but slow, so a retry with a longer
 * timeout might succeed (whereas a 404 FetchError will never succeed).
 *
 * @example
 * ```ts
 * throw new TimeoutError(
 *   "Request to https://slow-api.example.com timed out after 10000ms"
 * );
 * ```
 */
export class TimeoutError extends UrlReaderError {
  /**
   * @param message - Description including the URL and timeout duration.
   */
  constructor(message: string) {
    super(message, "TIMEOUT");
  }
}

/**
 * Thrown when the crawl token budget is exhausted.
 *
 * During BFS crawling, each fetched page consumes tokens from a fixed budget.
 * When the budget runs out, this error signals a graceful stop -- the partial
 * results collected so far are still valid and should be returned to the caller.
 *
 * This is NOT a failure in the traditional sense; it's a planned stopping
 * condition. Callers should catch this and return accumulated content.
 *
 * @example
 * ```ts
 * throw new TokenLimitError(
 *   "Token budget exhausted: used 100250 of 100000 allowed tokens"
 * );
 * ```
 */
export class TokenLimitError extends UrlReaderError {
  /**
   * @param message - Description including used and allowed token counts.
   */
  constructor(message: string) {
    super(message, "TOKEN_LIMIT_REACHED");
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Error Formatting
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Convert any error (known or unknown) to a human-readable string suitable
 * for inclusion in an MCP tool response.
 *
 * This is the **single exit point** for all error-to-string conversion in the
 * application. By centralizing this logic, we ensure consistent formatting
 * and can add future enrichments (e.g., error links, retry suggestions)
 * in one place.
 *
 * ## Formatting Rules
 * - {@link UrlReaderError} subclasses: `"[CODE] message"` -- includes the
 *   machine-readable code in brackets for both human and LLM consumption.
 * - Standard `Error` instances: just the `.message` property.
 * - Everything else (strings, numbers, null): coerced via `String()`.
 *
 * @param error - The caught value. Can be anything (`unknown`).
 * @returns A single-line human-readable error description.
 *
 * @example
 * ```ts
 * formatErrorForMcp(new FetchError("Not Found", 404));
 * // => "[FETCH_FAILED] Not Found"
 *
 * formatErrorForMcp(new TypeError("Cannot read property 'x' of null"));
 * // => "Cannot read property 'x' of null"
 *
 * formatErrorForMcp("something went wrong");
 * // => "something went wrong"
 *
 * formatErrorForMcp(42);
 * // => "42"
 * ```
 */
export function formatErrorForMcp(error: unknown): string {
  // WHY we check UrlReaderError first: it extends Error, so we need to
  // check the more specific type before the general one. Without this
  // order, UrlReaderError would match the `instanceof Error` branch and
  // lose the code prefix.
  if (error instanceof UrlReaderError) {
    return `[${error.code}] ${error.message}`;
  }

  // Standard Error objects (TypeError, RangeError, third-party lib errors, etc.)
  if (error instanceof Error) {
    return error.message;
  }

  // Last resort: strings, numbers, null, undefined, objects, etc.
  // String() handles all of these safely without throwing.
  return String(error);
}
