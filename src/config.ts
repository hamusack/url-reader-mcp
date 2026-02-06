/**
 * @module config
 * @fileoverview Centralized application configuration loaded from environment variables.
 *
 * All settings have sensible defaults for zero-config startup.
 * Every configurable value in the entire application flows through this single module,
 * making it the authoritative source of truth for operational parameters.
 *
 * ## Architecture Position
 * This module sits at the very bottom of the dependency graph -- it is imported by
 * nearly every other module (services, crawlers, tools) but imports nothing from the
 * application itself. This ensures no circular dependencies.
 *
 * ```
 *  +-----------+   +-----------+   +-----------+
 *  |   tools   |   |  crawler  |   | services  |
 *  +-----+-----+   +-----+-----+   +-----+-----+
 *        |               |               |
 *        +-------+-------+-------+-------+
 *                |               |
 *          +-----v-----+  +-----v-----+
 *          |   config   |  |   utils   |
 *          +-----------+  +-----------+
 * ```
 *
 * ## Extension Points
 * - Add new environment variables here when introducing features.
 * - Phase 2 additions: `JINA_API_KEY`, `ENABLE_BROWSER`, `BROWSER_TIMEOUT`
 * - Phase 3 additions: `RESPECT_ROBOTS_TXT`, `CUSTOM_USER_AGENT`, `ALLOWED_DOMAINS`
 *
 * ## Environment Variable Naming Convention
 * - All uppercase with underscores (SCREAMING_SNAKE_CASE).
 * - Numeric values are always parsed with `parseInt(..., 10)` to avoid octal surprises.
 * - Boolean values (future) should use `"true"` / `"false"` strings.
 *
 * @example
 * ```ts
 * // Most modules just import the pre-loaded singleton:
 * import { config } from "./config.js";
 * console.log(config.fetchTimeout); // 10000 (or whatever env says)
 *
 * // For testing, you can call loadConfig() to get a fresh snapshot:
 * import { loadConfig } from "./config.js";
 * process.env.FETCH_TIMEOUT = "5000";
 * const testConfig = loadConfig();
 * console.log(testConfig.fetchTimeout); // 5000
 * ```
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Type Definitions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Complete application configuration.
 *
 * Every field is required and has a default -- the app must never crash
 * because a config value is undefined.
 */
export interface AppConfig {
  /**
   * Default maximum character count returned by the `read_url` tool.
   *
   * WHY 50 000: A single web page rarely exceeds 50k meaningful characters
   * once boilerplate is stripped. This keeps responses within reasonable
   * LLM context limits while still capturing full articles.
   *
   * @default 50000
   */
  defaultMaxLength: number;

  /**
   * Default maximum token budget for the `crawl` tool's BFS traversal.
   *
   * WHY 100 000: Allows crawling roughly 5--10 pages of typical content
   * before the budget is exhausted. Prevents runaway crawls from consuming
   * unbounded resources.
   *
   * @default 100000
   */
  defaultMaxTokens: number;

  /**
   * HTTP request timeout in milliseconds.
   *
   * WHY 10 000 ms: Balances between giving slow servers a fair chance
   * and not blocking the MCP conversation for too long. Sites that don't
   * respond within 10 seconds are likely experiencing issues.
   *
   * @default 10000
   */
  fetchTimeout: number;

  /**
   * Time-to-live for cached responses, in seconds.
   *
   * WHY 3 600 (1 hour): Web content doesn't change every second. Caching
   * for an hour dramatically reduces redundant fetches during a single
   * conversation session while keeping content reasonably fresh.
   *
   * @default 3600
   */
  cacheTtl: number;

  /**
   * Maximum number of entries the in-memory cache can hold.
   *
   * WHY 500: Each cached entry holds extracted text (not raw HTML), so
   * memory footprint is moderate. 500 entries is enough for extensive
   * browsing sessions without risk of OOM in typical Node.js processes.
   *
   * @default 500
   */
  cacheMaxKeys: number;

  /**
   * Maximum number of concurrent outbound HTTP requests globally.
   *
   * WHY 3: Being a polite crawler means not hammering servers. Three
   * concurrent requests is aggressive enough for responsive crawling
   * while staying well within any reasonable rate limit.
   *
   * @default 3
   */
  maxConcurrent: number;

  /**
   * Minimum interval between requests to the same domain, in milliseconds.
   *
   * WHY 2 000 ms: The "crawl-delay" convention suggests 1--5 seconds.
   * Two seconds is a good middle ground -- fast enough for productive
   * crawling, slow enough to avoid triggering WAFs or rate limiters.
   *
   * @default 2000
   */
  perDomainInterval: number;

  /**
   * Maximum allowed response body size in bytes.
   *
   * WHY 10 MB (10 485 760 bytes): Protects against accidentally downloading
   * huge files (videos, archives). Most HTML pages are well under 1 MB;
   * 10 MB is a generous upper bound that catches PDFs and large pages
   * while blocking obviously non-textual content.
   *
   * @default 10485760
   */
  maxResponseSize: number;

  /**
   * Maximum number of HTTP redirects to follow.
   *
   * WHY 5: Most legitimate redirect chains are 1--3 hops (e.g., HTTP->HTTPS,
   * www->non-www, short URL->real URL). Five hops catches virtually all
   * real-world chains while protecting against infinite redirect loops.
   *
   * @default 5
   */
  maxRedirects: number;

  /**
   * User-Agent header sent with every outbound request.
   *
   * WHY include "MCP Server": Transparency is important. Site operators
   * should be able to identify automated traffic. The UA also includes
   * the project name and version for traceability.
   *
   * @default "mcp-url-reader/1.0 (MCP Server)"
   */
  userAgent: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Config Loader
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read environment variables and build a complete {@link AppConfig}.
 *
 * This function is intentionally **pure** -- it reads `process.env` at call
 * time and returns a plain object. This makes it easy to test: just set env
 * vars before calling, or call multiple times with different env states.
 *
 * **Parsing strategy:** Every numeric value is parsed with `parseInt(value, 10)`.
 * We explicitly pass radix 10 to prevent edge cases where a leading "0" could
 * be interpreted as octal in older runtimes (not a risk in modern V8, but a
 * good defensive habit).
 *
 * @returns A fully-populated {@link AppConfig} with all defaults applied.
 *
 * @example
 * ```ts
 * // Default config (no env vars set):
 * const cfg = loadConfig();
 * cfg.fetchTimeout; // 10000
 *
 * // Override via environment:
 * process.env.FETCH_TIMEOUT = "30000";
 * const cfg2 = loadConfig();
 * cfg2.fetchTimeout; // 30000
 * ```
 */
export function loadConfig(): AppConfig {
  return {
    defaultMaxLength: parseInt(process.env.DEFAULT_MAX_LENGTH ?? "50000", 10),
    defaultMaxTokens: parseInt(process.env.DEFAULT_MAX_TOKENS ?? "100000", 10),
    fetchTimeout: parseInt(process.env.FETCH_TIMEOUT ?? "10000", 10),
    cacheTtl: parseInt(process.env.CACHE_TTL ?? "3600", 10),

    // WHY not from env: cache key limit is a memory-safety knob that should
    // not be casually overridden by operators. If we need it configurable
    // later, we can add CACHE_MAX_KEYS.
    cacheMaxKeys: 500,

    maxConcurrent: parseInt(process.env.MAX_CONCURRENT ?? "3", 10),
    perDomainInterval: parseInt(process.env.PER_DOMAIN_INTERVAL ?? "2000", 10),
    maxResponseSize: parseInt(process.env.MAX_RESPONSE_SIZE ?? "10485760", 10),
    maxRedirects: parseInt(process.env.MAX_REDIRECTS ?? "5", 10),

    // WHY ?? instead of ||: We want to allow an explicit empty string to
    // fall through to the default. Nullish coalescing (??) treats "" as
    // truthy, but in practice nobody sets USER_AGENT="" intentionally.
    // If they do, the empty string will be used -- which is fine because
    // fetch() will just omit the header.
    userAgent:
      process.env.USER_AGENT ?? "mcp-url-reader/1.0 (MCP Server)",
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Singleton Export
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Pre-loaded configuration singleton.
 *
 * This is evaluated once at module load time. All modules that import `config`
 * share the same frozen snapshot of environment variables. This is intentional:
 * hot-reloading config mid-request would introduce subtle race conditions.
 *
 * If you need a fresh config (e.g., in tests), call {@link loadConfig} directly.
 *
 * @example
 * ```ts
 * import { config } from "./config.js";
 * // Use directly -- no function call needed:
 * const timeout = config.fetchTimeout;
 * ```
 */
export const config: AppConfig = loadConfig();
