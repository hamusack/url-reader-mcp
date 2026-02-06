/**
 * @fileoverview Concurrency control and rate-limiting service for the mcp-url-reader MCP server.
 *
 * This module implements a two-level queueing system that prevents the server from
 * overwhelming either itself or target websites with too many concurrent requests.
 *
 * ## Architecture: Two-Level Queue Design
 *
 * ```
 *   Incoming fetch requests
 *         |
 *         v
 *   [ Per-Domain Queue ]  <-- 1 concurrent, with interval delay
 *         |                    (prevents hammering a single domain)
 *         v
 *   [ Global Queue ]      <-- N concurrent (default 3)
 *         |                    (prevents overwhelming this server's resources)
 *         v
 *   Actual HTTP fetch
 * ```
 *
 * **Level 1 - Per-Domain Queues:**
 * Each unique domain (e.g., "example.com") gets its own queue with:
 * - Concurrency of 1: only one request per domain at a time
 * - Interval delay: minimum milliseconds between requests to the same domain
 *
 * This is critical for being a respectful web citizen. Rapid-firing requests
 * to a single domain can get us rate-limited, IP-banned, or cause DoS-like
 * load on small sites.
 *
 * **Level 2 - Global Queue:**
 * All domain queues feed into a single global queue with:
 * - Limited concurrency (default 3): caps total in-flight requests
 *
 * This prevents resource exhaustion on the MCP server itself (file descriptors,
 * memory for response buffers, CPU for HTML parsing).
 *
 * ## Why p-queue?
 *
 * p-queue is a battle-tested, Promise-based queue with built-in concurrency
 * control and interval support. It handles edge cases like queue draining,
 * error propagation, and backpressure correctly -- things that are surprisingly
 * tricky to implement from scratch.
 *
 * @module services/queue
 */

import PQueue from "p-queue";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// QueueManager Class
// ---------------------------------------------------------------------------

/**
 * Manages a two-level queue system for rate-limited, concurrent HTTP fetching.
 *
 * ## Usage
 *
 * ```typescript
 * import { queueManager } from "./services/queue.js";
 *
 * const html = await queueManager.enqueue("example.com", async () => {
 *   const res = await fetch("https://example.com/page");
 *   return res.text();
 * });
 * ```
 *
 * The enqueue method ensures that:
 * 1. Only one request to "example.com" runs at a time (domain queue)
 * 2. The request waits for the per-domain interval before executing
 * 3. Total concurrent requests across all domains are capped (global queue)
 *
 * @remarks
 * This class is NOT meant to be instantiated directly. Use the exported
 * `queueManager` singleton instead.
 */
class QueueManager {
  /**
   * The global concurrency queue that limits total in-flight requests.
   *
   * All tasks from per-domain queues are funneled through this queue.
   * The concurrency is set by `config.maxConcurrent` (default: 3).
   *
   * Why default 3? This is a conservative but practical default:
   * - Low enough to avoid overwhelming the server or network
   * - High enough to provide meaningful parallelism for multi-domain crawls
   * - Can be tuned up for servers with more resources
   */
  private globalQueue: PQueue;

  /**
   * Map of domain -> per-domain queue instances.
   *
   * Queues are lazily created on first access to a domain and kept alive
   * for the process lifetime. This is acceptable because:
   * - The number of unique domains in a typical session is bounded (dozens, not millions)
   * - PQueue instances are lightweight (a few hundred bytes each)
   * - Reusing the queue preserves the interval timing across multiple requests
   *   to the same domain within a session
   */
  private domainQueues: Map<string, PQueue>;

  /**
   * Minimum interval in milliseconds between requests to the same domain.
   *
   * Stored as an instance property so it's captured once at construction
   * time and used consistently for all lazily created domain queues.
   */
  private perDomainInterval: number;

  /**
   * Creates a new QueueManager instance.
   *
   * @param maxConcurrent - Maximum number of globally concurrent requests.
   *   Defaults to `config.maxConcurrent` (typically 3).
   *
   * @param domainInterval - Minimum milliseconds between requests to the same domain.
   *   Defaults to `config.perDomainInterval` (typically 2000ms).
   *
   * @example
   * ```typescript
   * // Typically use the singleton, but for testing:
   * const testQueue = new QueueManager(1, 500);
   * ```
   */
  constructor(maxConcurrent?: number, domainInterval?: number) {
    const concurrency = maxConcurrent ?? config.maxConcurrent;
    this.perDomainInterval = domainInterval ?? config.perDomainInterval;

    this.globalQueue = new PQueue({
      concurrency,
      // throwOnTimeout is false by default, which is what we want.
      // Timeouts are handled at the fetch level with AbortSignal, not here.
    });

    this.domainQueues = new Map();
  }

  // -------------------------------------------------------------------------
  // Domain Queue Management
  // -------------------------------------------------------------------------

  /**
   * Retrieves or creates a per-domain queue for the given domain.
   *
   * Domain queues are lazily initialized: the first request to a domain
   * creates the queue, and subsequent requests to the same domain reuse it.
   *
   * Each domain queue enforces:
   * - Concurrency of 1: serializes requests to the same domain
   * - Interval delay: waits at least N milliseconds between consecutive tasks
   *
   * @param domain - The domain name (e.g., "example.com", "api.github.com").
   *   This should be the hostname portion of the URL, without protocol or path.
   *
   * @returns The PQueue instance dedicated to this domain.
   *
   * @example
   * ```typescript
   * // Internal usage -- called by enqueue()
   * const queue = this.getDomainQueue("example.com");
   * // queue.concurrency === 1
   * ```
   */
  private getDomainQueue(domain: string): PQueue {
    let queue = this.domainQueues.get(domain);

    if (!queue) {
      queue = new PQueue({
        // Only one request to this domain at a time.
        // This is the most conservative and polite setting.
        concurrency: 1,

        // Minimum delay between the START of consecutive tasks.
        // p-queue's `interval` + `intervalCap` together control rate limiting:
        // - interval: the time window in milliseconds
        // - intervalCap: max tasks allowed to start within each window
        // Setting intervalCap=1 and interval=N means "at most 1 task per N ms".
        interval: this.perDomainInterval,
        intervalCap: 1,
      });

      this.domainQueues.set(domain, queue);
    }

    return queue;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Enqueues a task for execution with two-level rate limiting.
   *
   * The task flows through two queues in sequence:
   * 1. **Domain queue** - Waits for the domain's concurrency slot and interval
   * 2. **Global queue** - Waits for a global concurrency slot
   *
   * The returned Promise resolves with the task's return value, or rejects
   * if the task throws an error. Errors are propagated transparently through
   * both queue layers.
   *
   * ## Execution Flow
   *
   * ```
   * enqueue("example.com", fetchFn)
   *   |
   *   +---> domainQueue("example.com").add(() =>
   *   |       globalQueue.add(() =>
   *   |         fetchFn()
   *   |       )
   *   |     )
   *   |
   *   +---> resolves when fetchFn() completes
   * ```
   *
   * ## Why domain-first, then global?
   *
   * The domain queue acts as the first gate: it ensures we don't pile up
   * multiple requests to the same domain in the global queue. If we did
   * global-first, we could end up holding 3 global slots all targeting
   * the same domain, wasting concurrency that could be used for other domains.
   *
   * By going domain-first, we serialize per-domain and then let the global
   * queue optimally distribute its concurrency across different domains.
   *
   * @typeParam T - The return type of the task function.
   *
   * @param domain - The domain name for rate-limiting purposes.
   *   Use the hostname of the target URL (e.g., "docs.github.com").
   *
   * @param fn - An async function to execute. This is typically the actual
   *   HTTP fetch call wrapped in a closure.
   *
   * @returns A Promise that resolves with the task's return value.
   *
   * @throws Re-throws any error from the task function `fn`.
   *
   * @example
   * ```typescript
   * // Basic usage: fetch a page through the queue
   * const html = await queueManager.enqueue("example.com", async () => {
   *   const response = await fetch("https://example.com/page");
   *   return response.text();
   * });
   *
   * // Multiple domains can execute concurrently:
   * const [page1, page2] = await Promise.all([
   *   queueManager.enqueue("site-a.com", () => fetchPage("https://site-a.com")),
   *   queueManager.enqueue("site-b.com", () => fetchPage("https://site-b.com")),
   * ]);
   *
   * // Same domain is serialized with interval delay:
   * // These will run one at a time, 2s apart
   * const pages = await Promise.all([
   *   queueManager.enqueue("site-a.com", () => fetchPage("https://site-a.com/1")),
   *   queueManager.enqueue("site-a.com", () => fetchPage("https://site-a.com/2")),
   *   queueManager.enqueue("site-a.com", () => fetchPage("https://site-a.com/3")),
   * ]);
   * ```
   */
  async enqueue<T>(domain: string, fn: () => Promise<T>): Promise<T> {
    const domainQueue = this.getDomainQueue(domain);

    // Step 1: Enter the domain queue.
    // This ensures we respect per-domain concurrency and interval limits.
    // The domain queue's task is itself "enter the global queue and run fn".
    const result = await domainQueue.add(async () => {
      // Step 2: Enter the global queue.
      // This ensures we don't exceed the total concurrent request limit.
      // The actual work (fn) only executes when both queues grant a slot.
      return globalQueueAdd<T>(this.globalQueue, fn);
    });

    // p-queue's add() returns Promise<T | void> because it can return void
    // when throwOnTimeout is false and the task times out. Since we don't
    // use p-queue's timeout feature (we use AbortSignal instead), this
    // void case should never occur. The cast is safe in this context.
    return result as T;
  }

  /**
   * Returns the current number of pending + running tasks in the global queue.
   *
   * Useful for monitoring load and making decisions about whether to accept
   * new crawl requests.
   *
   * @returns The number of tasks that are either running or waiting in the global queue.
   *
   * @example
   * ```typescript
   * const load = queueManager.getGlobalLoad();
   * if (load > 10) {
   *   console.warn("High queue load, consider throttling new requests");
   * }
   * ```
   */
  getGlobalLoad(): number {
    return this.globalQueue.size + this.globalQueue.pending;
  }

  /**
   * Returns the number of unique domains that have active queues.
   *
   * @returns The count of domain queues currently in the map.
   *
   * @example
   * ```typescript
   * console.log(`Tracking ${queueManager.getDomainCount()} domains`);
   * ```
   */
  getDomainCount(): number {
    return this.domainQueues.size;
  }

  /**
   * Waits for all queues (global and all domain queues) to drain.
   *
   * This is primarily useful for:
   * - Graceful shutdown: ensuring all in-flight requests complete
   * - Testing: waiting for all async operations to finish
   *
   * @returns A Promise that resolves when all queues are idle.
   *
   * @example
   * ```typescript
   * // During graceful shutdown:
   * console.log("Waiting for all pending requests to complete...");
   * await queueManager.drain();
   * console.log("All requests completed, safe to exit.");
   * ```
   */
  async drain(): Promise<void> {
    // Wait for all domain queues to become idle first.
    // This ensures no new tasks are being added to the global queue.
    const domainDrains = Array.from(this.domainQueues.values()).map((q) =>
      q.onIdle()
    );
    await Promise.all(domainDrains);

    // Then wait for the global queue to finish any remaining tasks.
    await this.globalQueue.onIdle();
  }

  /**
   * Clears all pending (not yet started) tasks from all queues.
   *
   * Running tasks are NOT cancelled -- they will complete naturally.
   * Only tasks waiting in the queue are removed.
   *
   * @example
   * ```typescript
   * // Emergency stop: clear pending but let running tasks finish
   * queueManager.clearPending();
   * ```
   */
  clearPending(): void {
    this.globalQueue.clear();
    for (const queue of this.domainQueues.values()) {
      queue.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Helper Function
// ---------------------------------------------------------------------------

/**
 * Wraps a task function in a global queue add() call with proper typing.
 *
 * This helper exists to work around p-queue's complex generic typing.
 * Extracting it into a separate function makes the type inference cleaner
 * and avoids inline type assertions in the main enqueue() method.
 *
 * @typeParam T - The return type of the task function.
 * @param queue - The global PQueue instance.
 * @param fn - The task function to execute within the global queue.
 * @returns A Promise resolving to the task's return value.
 *
 * @internal This is an implementation detail, not part of the public API.
 */
async function globalQueueAdd<T>(
  queue: PQueue,
  fn: () => Promise<T>
): Promise<T> {
  const result = await queue.add(fn);
  return result as T;
}

// ---------------------------------------------------------------------------
// Singleton Export
// ---------------------------------------------------------------------------

/**
 * The singleton QueueManager instance shared across the entire application.
 *
 * All fetch operations should route through this manager to ensure proper
 * rate limiting and concurrency control.
 *
 * Initialized with values from `config.maxConcurrent` and `config.perDomainInterval`.
 *
 * @example
 * ```typescript
 * import { queueManager } from "./services/queue.js";
 *
 * // In the fetch service:
 * const html = await queueManager.enqueue(domain, () => fetch(url));
 * ```
 */
export const queueManager = new QueueManager();
