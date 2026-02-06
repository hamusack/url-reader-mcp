/**
 * @fileoverview HTML-to-Markdown conversion module with LLM-optimized post-processing.
 *
 * This module converts HTML fragments (typically from Readability's output) into
 * clean, well-formatted Markdown that is optimized for consumption by Large
 * Language Models (LLMs).
 *
 * **Why Turndown?**
 *   Turndown is the de facto standard for HTML→Markdown conversion in the Node.js
 *   ecosystem. It's rule-based, extensible, and produces predictable output. We
 *   chose it over alternatives (e.g., rehype-remark, html-to-text) because:
 *     - It has first-class support for custom rules (e.g., strikethrough).
 *     - Its output closely matches CommonMark, which LLMs are trained on.
 *     - It handles edge cases (nested lists, code blocks) gracefully.
 *
 * **LLM Optimization:**
 *   LLMs process Markdown more efficiently when it is clean and consistent.
 *   Our post-processing step:
 *     - Normalizes excessive newlines (max 2 consecutive) to reduce token waste.
 *     - Strips zero-width characters that can confuse tokenizers.
 *     - Optionally removes links (URLs are noisy for summarization tasks).
 *     - Optionally truncates to a max length (to fit context windows).
 *
 * @module extractor/markdown-converter
 */

import TurndownService from "turndown";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Options for controlling how HTML is converted to Markdown.
 *
 * These options allow callers to tailor the output for specific use cases
 * (e.g., summarization vs. full-content extraction).
 *
 * @example Default usage (keep links, no truncation)
 * ```typescript
 * const md = htmlToMarkdown(html);
 * ```
 *
 * @example Strip links for summarization
 * ```typescript
 * const md = htmlToMarkdown(html, { includeLinks: false });
 * ```
 *
 * @example Truncate for small context windows
 * ```typescript
 * const md = htmlToMarkdown(html, { maxLength: 8000 });
 * ```
 */
export interface MarkdownOptions {
  /**
   * Whether to preserve hyperlinks in the Markdown output.
   *
   * - `true` (default): Links are rendered as `[text](url)`.
   * - `false`: Links are replaced with just their anchor text, which is
   *   useful for summarization tasks where URLs add noise.
   */
  includeLinks?: boolean;

  /**
   * Maximum character length of the final Markdown output.
   *
   * When set, the output is truncated at the nearest word boundary that
   * doesn't exceed this limit, with an ellipsis appended. This is useful
   * for fitting content into LLM context windows.
   *
   * - `undefined` (default): No truncation.
   * - Any positive number: Truncate to approximately this many characters.
   */
  maxLength?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to match zero-width and invisible Unicode characters.
 *
 * **Why remove these?**
 * Some websites inject zero-width spaces (U+200B), zero-width joiners
 * (U+200D), byte-order marks (U+FEFF), and similar invisible characters
 * for layout purposes, copy-protection, or as tracking markers. These
 * characters:
 *   - Waste LLM tokens (each invisible char may tokenize as 1+ tokens).
 *   - Can break word-boundary detection in tokenizers.
 *   - Provide zero informational value in a text-extraction context.
 */
const ZERO_WIDTH_CHARS_REGEX =
  /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064]/g;

/**
 * Regex to match 3 or more consecutive newlines.
 *
 * **Why normalize?**
 * HTML-to-Markdown conversion often produces excessive blank lines between
 * elements (e.g., a `<div>` wrapping a `<p>` can generate 3-4 newlines).
 * We collapse these to exactly 2 newlines (one blank line), which:
 *   - Preserves paragraph separation (important for readability).
 *   - Eliminates wasted whitespace tokens.
 *   - Produces output consistent with typical Markdown style guides.
 */
const EXCESSIVE_NEWLINES_REGEX = /\n{3,}/g;

/**
 * Regex to match trailing whitespace on each line.
 *
 * Trailing spaces serve no purpose in Markdown (except for line breaks,
 * which are rare in extracted article content) and add unnecessary bytes.
 */
const TRAILING_WHITESPACE_REGEX = /[ \t]+$/gm;

// ---------------------------------------------------------------------------
// Turndown Instance Factory
// ---------------------------------------------------------------------------

/**
 * Create and configure a TurndownService instance.
 *
 * We create a new instance for each conversion call rather than reusing
 * a singleton. This is a deliberate choice because:
 *   1. TurndownService instances are lightweight (~1ms to create).
 *   2. The `includeLinks` option requires different rule configurations,
 *      and mutating a shared instance would introduce concurrency issues.
 *   3. Statelessness makes the function easier to test and reason about.
 *
 * @param includeLinks - Whether to preserve hyperlinks in the output.
 * @returns A configured TurndownService instance.
 */
function createTurndownService(includeLinks: boolean): TurndownService {
  const turndownService = new TurndownService({
    // Use ATX-style headings (# Heading) rather than Setext (underline)
    // because ATX is more universally recognized by LLMs and supports
    // all 6 heading levels consistently.
    headingStyle: "atx",

    // Use fenced code blocks (```) rather than indented code blocks
    // because fenced blocks support language hints (```python) and are
    // more commonly seen in training data for modern LLMs.
    codeBlockStyle: "fenced",

    // Use `-` for bullet lists (rather than `*` or `+`) for consistency
    // with the majority of Markdown style guides and GitHub Flavored Markdown.
    bulletListMarker: "-",

    // Use `_` for emphasis rather than `*` to reduce visual ambiguity
    // with bullet list markers.
    emPhasis: "_" as "underscore",
  });

  // -----------------------------------------------------------------------
  // Custom Rule: Strikethrough
  // -----------------------------------------------------------------------
  // HTML uses <del>, <s>, or <strike> for strikethrough text, but
  // TurndownService doesn't handle these by default. We add a custom rule
  // to convert them to GitHub Flavored Markdown's ~~strikethrough~~ syntax,
  // which is widely supported by LLMs and Markdown renderers.
  turndownService.addRule("strikethrough", {
    filter: ["del", "s", "strike"],
    replacement: (content: string) => {
      // Only wrap non-empty content to avoid producing `~~~~` artifacts.
      if (!content.trim()) return "";
      return `~~${content}~~`;
    },
  });

  // -----------------------------------------------------------------------
  // Link Handling
  // -----------------------------------------------------------------------
  // When `includeLinks` is false, we override the default anchor rule to
  // output only the link text, discarding the URL. This is useful for
  // summarization tasks where URLs add noise without informational value.
  if (!includeLinks) {
    turndownService.addRule("stripLinks", {
      filter: "a",
      replacement: (content: string) => {
        // Return the link text as-is. We trim to avoid extra whitespace
        // that was sometimes present in the original <a> tag.
        return content.trim();
      },
    });
  }

  return turndownService;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an HTML fragment to clean, LLM-optimized Markdown.
 *
 * This function is the primary entry point for HTML→Markdown conversion.
 * It creates a configured TurndownService instance, runs the conversion,
 * and applies post-processing to produce clean output.
 *
 * @param html    - The HTML fragment to convert. Typically the `content`
 *                  field from {@link ExtractedContent}.
 * @param options - Optional conversion settings. See {@link MarkdownOptions}.
 * @returns A clean Markdown string, ready for LLM consumption.
 *
 * @example Basic conversion
 * ```typescript
 * import { htmlToMarkdown } from "./markdown-converter.js";
 *
 * const md = htmlToMarkdown("<h1>Hello</h1><p>World</p>");
 * // Returns: "# Hello\n\nWorld"
 * ```
 *
 * @example With options
 * ```typescript
 * const md = htmlToMarkdown(
 *   '<p>Visit <a href="https://example.com">Example</a></p>',
 *   { includeLinks: false, maxLength: 100 }
 * );
 * // Returns: "Visit Example"
 * ```
 *
 * @example Strikethrough support
 * ```typescript
 * const md = htmlToMarkdown("<p>This is <del>wrong</del> right</p>");
 * // Returns: "This is ~~wrong~~ right"
 * ```
 */
export function htmlToMarkdown(
  html: string,
  options: MarkdownOptions = {},
): string {
  // Destructure with defaults. Using explicit defaults rather than
  // `??` chains for clarity and self-documentation.
  const { includeLinks = true, maxLength } = options;

  // Handle empty/whitespace-only input gracefully.
  // This prevents Turndown from producing unexpected artifacts when
  // given degenerate input (e.g., just whitespace or empty string).
  if (!html || !html.trim()) {
    return "";
  }

  // Create a fresh TurndownService configured for this conversion.
  const turndownService = createTurndownService(includeLinks);

  // Run the HTML→Markdown conversion.
  // Turndown processes the HTML top-to-bottom, applying rules to each
  // element to produce the corresponding Markdown syntax.
  let markdown = turndownService.turndown(html);

  // Apply post-processing to normalize whitespace, remove invisible
  // characters, and clean up any artifacts from the conversion.
  markdown = postProcessMarkdown(markdown);

  // Apply optional truncation.
  // We truncate *after* post-processing to ensure the length check
  // operates on the final, cleaned output rather than pre-cleanup text
  // that might shrink during normalization.
  if (maxLength !== undefined && maxLength > 0 && markdown.length > maxLength) {
    markdown = truncateAtWordBoundary(markdown, maxLength);
  }

  return markdown;
}

/**
 * Post-process a Markdown string to normalize whitespace and remove artifacts.
 *
 * This function is intentionally exported for two reasons:
 *   1. It can be used independently on Markdown from other sources.
 *   2. It enables targeted unit testing of the cleanup logic.
 *
 * **Processing steps (in order):**
 *   1. Remove zero-width/invisible Unicode characters.
 *   2. Collapse 3+ consecutive newlines to exactly 2 (one blank line).
 *   3. Remove trailing whitespace from each line.
 *   4. Trim leading/trailing whitespace from the entire string.
 *
 * The order matters: we remove invisible chars first so they don't
 * interfere with the newline/whitespace normalization regexes.
 *
 * @param markdown - The raw Markdown string to clean up.
 * @returns The cleaned Markdown string.
 *
 * @example
 * ```typescript
 * import { postProcessMarkdown } from "./markdown-converter.js";
 *
 * const dirty = "# Hello\n\n\n\n\nWorld\u200B  \n  ";
 * const clean = postProcessMarkdown(dirty);
 * // Returns: "# Hello\n\nWorld"
 * ```
 */
export function postProcessMarkdown(markdown: string): string {
  return (
    markdown
      // Step 1: Strip zero-width characters.
      // Must happen first — these invisible chars can hide between newlines
      // and prevent the newline normalization regex from matching correctly.
      .replace(ZERO_WIDTH_CHARS_REGEX, "")

      // Step 2: Collapse excessive newlines.
      // Three or more consecutive newlines become exactly two, preserving
      // the "one blank line between paragraphs" convention.
      .replace(EXCESSIVE_NEWLINES_REGEX, "\n\n")

      // Step 3: Remove trailing whitespace on each line.
      // The `m` flag in the regex makes `$` match end-of-line, not just
      // end-of-string.
      .replace(TRAILING_WHITESPACE_REGEX, "")

      // Step 4: Trim the entire string.
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a Markdown string at the nearest word boundary.
 *
 * We avoid cutting in the middle of a word because:
 *   1. Partial words confuse LLM tokenizers and may produce garbage tokens.
 *   2. It looks unprofessional in user-facing output.
 *   3. The token savings from cutting mid-word are negligible.
 *
 * The truncation point is found by searching backwards from `maxLength`
 * for a whitespace character. If no whitespace is found (e.g., a single
 * very long word), we fall back to hard-cutting at `maxLength`.
 *
 * An ellipsis marker (" ...") is appended to indicate truncation, so
 * the actual content is `maxLength - 4` characters at most.
 *
 * @param text      - The Markdown string to truncate.
 * @param maxLength - The maximum allowed length (including the ellipsis).
 * @returns The truncated string with an ellipsis appended.
 *
 * @example
 * ```typescript
 * truncateAtWordBoundary("Hello beautiful world", 15);
 * // Returns: "Hello ...";
 * // (cuts before "beautiful" because "Hello beautiful" is 15 chars,
 * //  but we need room for " ...")
 * ```
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
  // Reserve space for the ellipsis marker.
  const ELLIPSIS = " ...";
  const targetLength = maxLength - ELLIPSIS.length;

  // Edge case: if maxLength is so small that we can't even fit the
  // ellipsis, just hard-truncate.
  if (targetLength <= 0) {
    return text.slice(0, maxLength);
  }

  // Search backwards from the target length for a whitespace character.
  // This gives us the last word boundary that fits within our budget.
  const truncated = text.slice(0, targetLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > 0) {
    // Found a word boundary — cut there.
    return truncated.slice(0, lastSpace) + ELLIPSIS;
  }

  // No whitespace found (single very long word or token) — hard-cut.
  // This is rare in natural language but can happen with URLs or code.
  return truncated + ELLIPSIS;
}
